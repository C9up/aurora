import { afterEach, describe, expect, it, vi } from "vitest";
import {
	HttpClient,
	HttpError,
	http,
	isAbortError,
	isHttpError,
} from "../../src/http.js";

interface Call {
	url: string;
	init: RequestInit;
}

/** Stub `fetch`, recording each call; `responder` produces the Response per call. */
function stubFetch(responder: (call: Call) => Response): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string, init: RequestInit = {}) => {
			const call = { url, init };
			calls.push(call);
			return Promise.resolve(responder(call));
		}),
	);
	return calls;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("aurora > http > HttpClient", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("get parses a JSON response", async () => {
		stubFetch(() => json({ ok: true, user: { id: 1 } }));
		const client = new HttpClient();
		const data = await client.get<{ ok: boolean; user: { id: number } }>(
			"/auth/me",
		);
		expect(data).toEqual({ ok: true, user: { id: 1 } });
	});

	it("injects a static bearer token", async () => {
		const calls = stubFetch(() => json({}));
		const client = new HttpClient({ token: "abc" });
		await client.get("/me");
		expect(new Headers(calls[0].init.headers).get("authorization")).toBe(
			"Bearer abc",
		);
	});

	it("reads a token getter fresh on each request", async () => {
		const calls = stubFetch(() => json({}));
		let token = "t1";
		const client = new HttpClient({ token: () => token });
		await client.get("/me");
		token = "t2";
		await client.get("/me");
		expect(new Headers(calls[0].init.headers).get("authorization")).toBe(
			"Bearer t1",
		);
		expect(new Headers(calls[1].init.headers).get("authorization")).toBe(
			"Bearer t2",
		);
	});

	it("does not override a caller-set Authorization header", async () => {
		const calls = stubFetch(() => json({}));
		const client = new HttpClient({ token: "abc" });
		await client.get("/me", { headers: { Authorization: "Bearer custom" } });
		expect(new Headers(calls[0].init.headers).get("authorization")).toBe(
			"Bearer custom",
		);
	});

	it("JSON-encodes a plain-object body and sets content-type", async () => {
		const calls = stubFetch(() => json({}));
		const client = new HttpClient();
		await client.post("/users", { name: "Ada" });
		const { init } = calls[0];
		expect(init.method).toBe("POST");
		expect(new Headers(init.headers).get("content-type")).toBe(
			"application/json",
		);
		expect(
			typeof init.body === "string" ? JSON.parse(init.body) : null,
		).toEqual({ name: "Ada" });
	});

	it("passes FormData through without a JSON content-type", async () => {
		const calls = stubFetch(() => json({}));
		const client = new HttpClient();
		const form = new FormData();
		form.append("file", "x");
		await client.post("/upload", form);
		const { init } = calls[0];
		expect(init.body).toBe(form);
		expect(new Headers(init.headers).get("content-type")).toBeNull();
	});

	it("prepends baseURL but leaves absolute URLs untouched", async () => {
		const calls = stubFetch(() => json({}));
		const client = new HttpClient({ baseURL: "https://api.test" });
		await client.get("/a");
		await client.get("https://other.test/b");
		expect(calls[0].url).toBe("https://api.test/a");
		expect(calls[1].url).toBe("https://other.test/b");
	});

	it("does not send managed bearer auth to cross-origin absolute URLs by default", async () => {
		const calls = stubFetch(() => json({}));
		const client = new HttpClient({
			baseURL: "https://api.test",
			token: "secret",
		});

		await client.get("https://other.test/b");

		expect(calls[0].url).toBe("https://other.test/b");
		expect(new Headers(calls[0].init.headers).get("authorization")).toBeNull();
	});

	it("strips default Authorization on cross-origin absolute URLs unless explicitly allowed", async () => {
		const calls = stubFetch(() => json({}));
		const client = new HttpClient({
			baseURL: "https://api.test",
			headers: { Authorization: "Bearer default" },
		});

		await client.get("https://other.test/b");
		await client.get("https://other.test/c", { allowCrossOriginAuth: true });
		await client.get("https://other.test/d", {
			headers: { Authorization: "Bearer explicit" },
		});

		expect(new Headers(calls[0].init.headers).get("authorization")).toBeNull();
		expect(new Headers(calls[1].init.headers).get("authorization")).toBe(
			"Bearer default",
		);
		expect(new Headers(calls[2].init.headers).get("authorization")).toBe(
			"Bearer explicit",
		);
	});

	it("appends query params, skipping null/undefined", async () => {
		const calls = stubFetch(() => json({}));
		const client = new HttpClient();
		await client.get("/search", {
			query: { q: "hi", page: 2, empty: null, missing: undefined },
		});
		expect(calls[0].url).toBe("/search?q=hi&page=2");
	});

	it("throws HttpError with status and parsed body on non-2xx", async () => {
		stubFetch(() => json({ message: "nope" }, 422));
		const client = new HttpClient();
		await expect(client.get("/x")).rejects.toMatchObject({
			name: "HttpError",
			status: 422,
			data: { message: "nope" },
		});
		const err = await client.get("/x").catch((e) => e);
		expect(err).toBeInstanceOf(HttpError);
	});

	it("returns null for a 204 No Content response", async () => {
		stubFetch(() => new Response(null, { status: 204 }));
		const client = new HttpClient();
		expect(await client.delete("/x")).toBeNull();
	});

	it("uses a parse validator when provided", async () => {
		stubFetch(() => json({ n: "7" }));
		const client = new HttpClient();
		const n = await client.get("/x", {
			parse: (raw) => Number((raw as { n: string }).n),
		});
		expect(n).toBe(7);
	});

	it("raw() returns the Response without parsing or throwing", async () => {
		stubFetch(() => json({ a: 1 }, 500));
		const client = new HttpClient();
		const res = await client.raw("GET", "/x");
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ a: 1 });
	});

	it("extend() merges defaults", async () => {
		const calls = stubFetch(() => json({}));
		const base = new HttpClient({ baseURL: "https://api.test" });
		const authed = base.extend({ token: "abc" });
		await authed.get("/me");
		expect(calls[0].url).toBe("https://api.test/me");
		expect(new Headers(calls[0].init.headers).get("authorization")).toBe(
			"Bearer abc",
		);
	});

	it("exposes a default same-origin `http` instance", async () => {
		const calls = stubFetch(() => json({ ok: true }));
		await http.get("/ping");
		expect(calls[0].url).toBe("/ping");
	});

	it("manages default headers via setHeader/setHeaders/removeHeader", async () => {
		const calls = stubFetch(() => json({}));
		const client = new HttpClient();
		client
			.setHeader("X-App", "ream")
			.setHeaders({ "Accept-Language": "fr", "X-Trace": "1" })
			.removeHeader("x-trace");
		await client.get("/x");
		const sent = new Headers(calls[0].init.headers);
		expect(sent.get("x-app")).toBe("ream");
		expect(sent.get("accept-language")).toBe("fr");
		expect(sent.get("x-trace")).toBeNull();
	});

	it("setHeader replaces case-insensitively (no duplicate keys)", async () => {
		const calls = stubFetch(() => json({}));
		const client = new HttpClient({
			headers: { "content-type": "text/plain" },
		});
		client.setHeader("Content-Type", "application/xml");
		await client.get("/x");
		expect(new Headers(calls[0].init.headers).get("content-type")).toBe(
			"application/xml",
		);
		expect(client.getHeaders()).toEqual({ "Content-Type": "application/xml" });
	});

	it("per-request headers override the managed defaults", async () => {
		const calls = stubFetch(() => json({}));
		const client = new HttpClient().setHeader("X-App", "ream");
		await client.get("/x", { headers: { "X-App": "override" } });
		expect(new Headers(calls[0].init.headers).get("x-app")).toBe("override");
	});
});

describe("aurora > http > error handling (attempt / isHttpError)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("attempt() resolves ok:true with data on a 2xx", async () => {
		stubFetch(() => json({ id: 1 }));
		const api = new HttpClient();
		const r = await api.attempt(api.get<{ id: number }>("/x"));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.data).toEqual({ id: 1 });
	});

	it("attempt() resolves ok:false with the HttpError on a non-2xx", async () => {
		stubFetch(() => json({ error: "bad" }, 422));
		const api = new HttpClient();
		const r = await api.attempt(api.post("/x", {}));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toBeInstanceOf(HttpError);
			expect(r.error.status).toBe(422);
			expect(r.error.data).toEqual({ error: "bad" });
		}
	});

	it("attempt() rethrows a non-HTTP transport error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
		);
		const api = new HttpClient();
		await expect(api.attempt(api.get("/x"))).rejects.toBeInstanceOf(TypeError);
	});

	it("isHttpError narrows", () => {
		const err = new HttpError(new Response(null, { status: 500 }), null);
		expect(isHttpError(err)).toBe(true);
		expect(isHttpError(new Error("x"))).toBe(false);
		expect(isHttpError(null)).toBe(false);
	});
});

describe("aurora > http > abort & timeout", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("forwards a per-request abort signal to fetch", async () => {
		const calls = stubFetch(() => json({}));
		const controller = new AbortController();
		await new HttpClient().get("/x", { signal: controller.signal });
		expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
	});

	it("attaches an abort signal when a timeout is configured", async () => {
		const calls = stubFetch(() => json({}));
		await new HttpClient({ timeout: 5000 }).get("/x");
		expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
	});

	it("sends no signal when neither timeout nor signal is given", async () => {
		const calls = stubFetch(() => json({}));
		await new HttpClient().get("/x");
		expect(calls[0].init.signal).toBeUndefined();
	});

	it("a request aborted via its signal rejects with an abort error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit = {}) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener("abort", () =>
							reject(
								Object.assign(new Error("aborted"), { name: "AbortError" }),
							),
						);
					}),
			),
		);
		const api = new HttpClient();
		const controller = new AbortController();
		const pending = api.get("/x", { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toSatisfy(isAbortError);
	});

	it("isAbortError recognizes AbortError and TimeoutError only", () => {
		const abort = Object.assign(new Error("a"), { name: "AbortError" });
		const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
		expect(isAbortError(abort)).toBe(true);
		expect(isAbortError(timeout)).toBe(true);
		expect(isAbortError(new Error("other"))).toBe(false);
		expect(isAbortError(null)).toBe(false);
	});
});
