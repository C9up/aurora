import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/http.js";

/**
 * A client derived with `extend()` for another origin must not carry the
 * parent's credentials there: they were issued for the parent's origin, and
 * the child's requests to its own baseURL look same-origin to the per-request
 * check.
 */

const OTHER = "https://api.other.example";

function capture(): Array<Headers> {
	const seen: Array<Headers> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((_url: string, init: RequestInit = {}) => {
			seen.push(new Headers(init.headers));
			return Promise.resolve(new Response("{}", { status: 200 }));
		}),
	);
	return seen;
}

async function authorizationOf(client: HttpClient, url: string) {
	const seen = capture();
	await client.get(url);
	return seen[0]?.get("authorization") ?? null;
}

describe("aurora > http > extend() and inherited credentials", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("drops the inherited token when the origin changes", async () => {
		const app = new HttpClient({ token: "APP-SESSION-JWT" });
		const other = app.extend({ baseURL: OTHER });
		expect(await authorizationOf(other, "/v1/things")).toBeNull();
	});

	it("drops the inherited Authorization header when the origin changes", async () => {
		const app = new HttpClient({
			headers: { Authorization: "Bearer APP-DEFAULT-HEADER", Accept: "x/y" },
		});
		const other = app.extend({ baseURL: OTHER });
		expect(await authorizationOf(other, "/v1/things")).toBeNull();
		// Only credentials go; the rest of the defaults still apply.
		expect(other.getHeaders()).toEqual({ Accept: "x/y" });
	});

	it("drops a header spelled in any case, and the XSRF header", () => {
		const app = new HttpClient({
			headers: {
				authorization: "Bearer a",
				"Proxy-Authorization": "Basic b",
				"X-XSRF-TOKEN": "c",
				"X-Trace": "keep",
			},
		});
		expect(app.extend({ baseURL: OTHER }).getHeaders()).toEqual({
			"X-Trace": "keep",
		});
	});

	it("keeps them for the same origin", async () => {
		const app = new HttpClient({ token: "T" });
		expect(await authorizationOf(app.extend({ baseURL: "/api" }), "/x")).toBe(
			"Bearer T",
		);
		const absolute = new HttpClient({ baseURL: OTHER, token: "T" });
		expect(
			await authorizationOf(absolute.extend({ baseURL: `${OTHER}/v2` }), "/x"),
		).toBe("Bearer T");
		const page = new HttpClient({ token: "T" });
		expect(
			await authorizationOf(
				page.extend({ baseURL: window.location.origin }),
				"/x",
			),
		).toBe("Bearer T");
	});

	it("sends a token the extension gives explicitly", async () => {
		const app = new HttpClient({ token: "APP" });
		const other = app.extend({ baseURL: OTHER, token: "THIRD-PARTY" });
		expect(await authorizationOf(other, "/v1")).toBe("Bearer THIRD-PARTY");
		const withHeader = app.extend({
			baseURL: OTHER,
			headers: { Authorization: "Bearer EXPLICIT" },
		});
		expect(await authorizationOf(withHeader, "/v1")).toBe("Bearer EXPLICIT");
	});

	it("keeps them when the extension opts in with allowCrossOriginAuth", async () => {
		const app = new HttpClient({ token: "APP" });
		const other = app.extend({ baseURL: OTHER, allowCrossOriginAuth: true });
		expect(await authorizationOf(other, "/v1")).toBe("Bearer APP");
	});

	it("reads token: null as no token, same origin or not", async () => {
		const app = new HttpClient({ token: "APP" });
		expect(
			await authorizationOf(app.extend({ token: null }), "/me"),
		).toBeNull();
		expect(
			await authorizationOf(app.extend({ baseURL: OTHER, token: null }), "/x"),
		).toBeNull();
	});

	it("still inherits the token when the extension says nothing about it", async () => {
		const app = new HttpClient({ token: () => "LIVE" });
		expect(
			await authorizationOf(app.extend({ headers: { X: "1" } }), "/me"),
		).toBe("Bearer LIVE");
	});

	it("drops them across a chain of extensions", async () => {
		const app = new HttpClient({ token: "APP" });
		const scoped = app.extend({ headers: { "X-Scope": "1" } });
		const other = scoped.extend({ baseURL: `//${new URL(OTHER).host}` });
		expect(await authorizationOf(other, "/v1")).toBeNull();
	});
});
