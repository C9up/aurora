import { afterEach, describe, expect, it } from "vitest";
import { HttpClient } from "../../src/http.js";
import {
	carriesOwnAuthority,
	isCrossOriginRequest,
	isSameOriginAsPage,
} from "../../src/requestOrigin.js";

/**
 * Where a request actually goes, and which of the page's secrets ride along.
 *
 * Three places used to answer this with their own copy of "does it start with a
 * scheme". A protocol-relative URL has no scheme and goes wherever it names, so
 * `//evil.example/x` read as RELATIVE and the client sent it the default Bearer,
 * the default Authorization header and the CSRF token. The backslash spellings
 * did the same, because a browser treats a backslash in the authority position
 * as a slash for http(s) — which is why the rule is now the URL parser's answer
 * rather than a pattern of our own.
 */

const PAGE = "https://app.example.com/dash";

/** Every spelling of "this URL brings its own host". */
const FOREIGN = [
	"//evil.example/x",
	"\\\\evil.example/x",
	"/\\evil.example/x",
	"\\/evil.example/x",
	"https://evil.example/x",
	"HTTPS://evil.example/x",
	"http://app.example.com/x",
] as const;

/** URLs that have no choice but to resolve against the page. */
const LOCAL = [
	"/api/me",
	"api/me",
	"",
	"#frag",
	"?q=1",
	"./x",
	"../y",
] as const;

/**
 * Stand the tests on a known page, and put back what was there.
 *
 * Restored rather than deleted: the test environment supplies its own `window`,
 * and deleting it left every later test in the file running as if there were no
 * browser — which is a different code path and quietly passed some of them.
 */
const originalWindow = Reflect.get(globalThis, "window");

afterEach(() => {
	Reflect.set(globalThis, "window", originalWindow);
});

function onPage(href = PAGE): void {
	Reflect.set(globalThis, "window", { location: new URL(href) });
}

/** And the case with no browser at all, which SSR is. */
function offPage(): void {
	Reflect.deleteProperty(globalThis, "window");
}

describe("request origin > carriesOwnAuthority", () => {
	it("is true for every spelling of an authority, not just a scheme", () => {
		for (const url of FOREIGN) {
			expect(carriesOwnAuthority(url), url).toBe(true);
		}
	});

	it("is false for a URL that must resolve against its base", () => {
		for (const url of LOCAL) {
			expect(carriesOwnAuthority(url), url).toBe(false);
		}
	});

	it("treats a URL the parser refuses as foreign, not as safe", () => {
		// Fail closed: an origin we could not work out is not one to trust.
		expect(carriesOwnAuthority("http://[")).toBe(true);
	});

	it("answers without a browser", () => {
		// The probe base is its own reference, so this holds during SSR too.
		offPage();
		expect(carriesOwnAuthority("//evil.example/x")).toBe(true);
		expect(carriesOwnAuthority("/api/me")).toBe(false);
	});
});

describe("request origin > the page's CSRF token", () => {
	it("is withheld from every foreign spelling", () => {
		onPage();
		for (const url of FOREIGN) {
			expect(isSameOriginAsPage(url), url).toBe(false);
		}
	});

	it("still goes to the page's own origin", () => {
		onPage();
		for (const url of LOCAL) {
			expect(isSameOriginAsPage(url), url).toBe(true);
		}
		expect(isSameOriginAsPage("https://app.example.com/api")).toBe(true);
	});

	it("goes nowhere outside a browser", () => {
		offPage();
		expect(isSameOriginAsPage("/api/me")).toBe(false);
	});
});

describe("request origin > the default Bearer", () => {
	it("is withheld from every foreign spelling", () => {
		onPage();
		for (const url of FOREIGN) {
			expect(isCrossOriginRequest(url, ""), url).toBe(true);
		}
	});

	it("rides along on a URL that resolves against the page", () => {
		onPage();
		for (const url of LOCAL) {
			expect(isCrossOriginRequest(url, ""), url).toBe(false);
		}
	});

	it("is measured against the client's own baseURL when it has one", () => {
		onPage();
		const base = "https://api.example.com";
		expect(isCrossOriginRequest(`${base}/me`, base)).toBe(false);
		expect(isCrossOriginRequest("https://evil.example/me", base)).toBe(true);
		// A protocol-relative URL ignores the baseURL, so it is foreign to it.
		expect(isCrossOriginRequest("//evil.example/me", base)).toBe(true);
	});

	it("is withheld when no origin can be worked out at all", () => {
		// No page to compare against — `window` is not even declared, which is the
		// shape that used to throw a ReferenceError rather than answer.
		offPage();
		expect(isCrossOriginRequest("https://evil.example/x", "")).toBe(true);
		expect(isCrossOriginRequest("//evil.example/x", "")).toBe(true);
	});
});

describe("http client > what fetch is actually handed", () => {
	/** Capture the request the client makes, through the real code path. */
	function capture(): { url: () => string; headers: () => Headers } {
		let seen: { url: string; init?: RequestInit } | undefined;
		Reflect.set(globalThis, "fetch", (url: string, init?: RequestInit) => {
			seen = { url, init };
			return Promise.resolve(new Response("{}", { status: 200 }));
		});
		return {
			url: () => seen?.url ?? "",
			headers: () => new Headers(seen?.init?.headers ?? {}),
		};
	}

	afterEach(() => {
		Reflect.deleteProperty(globalThis, "fetch");
	});

	it("puts the query before the fragment, where the server can read it", async () => {
		// Appended at the end, `/items#tab` became `/items#tab?q=x` — the whole
		// query swallowed by the fragment, which is never sent to the server, so
		// the parameters silently did nothing.
		const seen = capture();
		const client = new HttpClient();
		await client.get("/items#tab", { query: { q: "x" } });
		expect(seen.url()).toBe("/items?q=x#tab");
		await client.get("/items?a=1#tab", { query: { q: "x" } });
		expect(seen.url()).toBe("/items?a=1&q=x#tab");
		await client.get("/items", { query: { q: "x" } });
		expect(seen.url()).toBe("/items?q=x");
		await client.get("/items#tab");
		expect(seen.url()).toBe("/items#tab");
	});

	it("does not prefix the baseURL onto a URL that names its own host", async () => {
		const seen = capture();
		const client = new HttpClient({ baseURL: "https://api.example.com" });
		await client.get("/me");
		expect(seen.url()).toBe("https://api.example.com/me");
		await client.get("https://other.test/me");
		expect(seen.url()).toBe("https://other.test/me");
		// The one the scheme test missed: prefixing it would send the request
		// somewhere neither the caller nor the client meant.
		await client.get("//other.test/me");
		expect(seen.url()).toBe("//other.test/me");
	});

	it("withholds the default Bearer from a protocol-relative host", async () => {
		onPage();
		const seen = capture();
		const client = new HttpClient({ token: "secret-token" });
		await client.get("/api/me");
		expect(seen.headers().get("authorization")).toBe("Bearer secret-token");
		await client.get("//evil.example/steal");
		expect(seen.headers().get("authorization")).toBeNull();
		// Two backslashes, which is the authority form. One is just a path.
		await client.get("\\\\evil.example/steal");
		expect(seen.headers().get("authorization")).toBeNull();
		await client.get("\\evil.example/steal");
		expect(seen.headers().get("authorization")).toBe("Bearer secret-token");
	});

	it("withholds a default Authorization header from one too", async () => {
		onPage();
		const seen = capture();
		const client = new HttpClient({
			headers: { Authorization: "Basic abc" },
		});
		await client.get("/api/me");
		expect(seen.headers().get("authorization")).toBe("Basic abc");
		await client.get("//evil.example/steal");
		expect(seen.headers().get("authorization")).toBeNull();
	});
});
