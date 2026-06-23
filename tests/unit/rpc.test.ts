import { afterEach, describe, expect, it, vi } from "vitest";
import { createRpcClient, isRpcError, RpcError } from "../../src/rpc.js";

interface RpcReq {
	jsonrpc: string;
	method: string;
	params?: unknown;
	id: number;
}

/** Stub global fetch with a handler over the parsed request body → response body. */
function stubFetch<B>(handler: (body: B) => unknown): ReturnType<typeof vi.fn> {
	const mock = vi.fn(async (_url: string, init?: { body?: string }) => {
		const resBody = handler(JSON.parse(init?.body ?? "null"));
		return {
			ok: true,
			status: 200,
			headers: { get: () => "application/json" },
			text: async () => JSON.stringify(resBody),
		};
	});
	vi.stubGlobal("fetch", mock);
	return mock;
}

describe("aurora/rpc > createRpcClient", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("sends a JSON-RPC 2.0 envelope and returns the result", async () => {
		const fetchMock = stubFetch<RpcReq>((req) => ({
			jsonrpc: "2.0",
			result: { valid: true },
			id: req.id,
		}));
		const rpc = createRpcClient();

		const out = await rpc.call<{ valid: boolean }>("task.validate", { id: 7 });
		expect(out).toEqual({ valid: true });

		const init = fetchMock.mock.calls[0][1];
		expect(fetchMock.mock.calls[0][0]).toBe("/rpc");
		const sent = JSON.parse(init.body);
		expect(sent).toMatchObject({
			jsonrpc: "2.0",
			method: "task.validate",
			params: { id: 7 },
		});
		expect(typeof sent.id).toBe("number");
	});

	it("throws RpcError (code + message + data) on a JSON-RPC error", async () => {
		stubFetch<RpcReq>((req) => ({
			jsonrpc: "2.0",
			error: {
				code: -32601,
				message: "Method not found",
				data: { method: "nope" },
			},
			id: req.id,
		}));
		const rpc = createRpcClient();

		const err = await rpc.call("nope").catch((e) => e);
		expect(err).toBeInstanceOf(RpcError);
		if (!isRpcError(err)) throw new Error("expected an RpcError");
		expect(err.code).toBe(-32601);
		expect(err.message).toBe("Method not found");
		expect(err.data).toEqual({ method: "nope" });
	});

	it("uses a `parse` validator instead of the unchecked assertion", async () => {
		stubFetch<RpcReq>((req) => ({
			jsonrpc: "2.0",
			result: { n: 41 },
			id: req.id,
		}));
		const rpc = createRpcClient();

		const out = await rpc.call("m", undefined, (data) => {
			if (typeof data !== "object" || data === null || !("n" in data)) {
				throw new Error("bad shape");
			}
			return { n: Number(data.n) + 1 };
		});
		expect(out).toEqual({ n: 42 });
	});

	it("honours a custom url + injected HttpClient headers", async () => {
		const fetchMock = stubFetch<RpcReq>((req) => ({
			jsonrpc: "2.0",
			result: "ok",
			id: req.id,
		}));
		const rpc = createRpcClient({
			url: "/api/rpc",
			headers: { authorization: "Bearer t" },
		});
		await rpc.call("ping");

		expect(fetchMock.mock.calls[0][0]).toBe("/api/rpc");
		expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer t");
	});

	it("batch() returns one settled entry per call, matched by id, in request order", async () => {
		stubFetch<RpcReq[]>((reqs) =>
			// Server reorders the responses — the client must re-match by id.
			reqs
				.map((r) =>
					r.method === "boom"
						? {
								jsonrpc: "2.0",
								error: { code: -32000, message: "boom" },
								id: r.id,
							}
						: { jsonrpc: "2.0", result: `${r.method}-ok`, id: r.id },
				)
				.reverse(),
		);
		const rpc = createRpcClient();

		const results = await rpc.batch([
			{ method: "a" },
			{ method: "boom" },
			{ method: "b" },
		]);
		expect(results[0]).toEqual({ ok: true, value: "a-ok" });
		expect(results[1].ok).toBe(false);
		if (!results[1].ok) expect(results[1].error.message).toBe("boom");
		expect(results[2]).toEqual({ ok: true, value: "b-ok" });
	});
});
