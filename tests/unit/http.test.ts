import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError, http } from "../../src/http.js";

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
