/**
 * Browser JSON-RPC 2.0 client for Ream's RPC endpoint. `@c9up/ream`'s
 * RpcProvider mounts `POST /rpc` and speaks JSON-RPC 2.0 (single + batch); this
 * client builds on aurora's {@link HttpClient}, inheriting its base URL, auth
 * headers, and timeouts.
 *
 *   const rpc = createRpcClient()                              // POST /rpc, same-origin
 *   const result = await rpc.call('task.validate', { id })     // typed via call<T>()
 *   const user = await rpc.call('user.find', { id }, { parse: isUser }) // validated, cast-free
 *   await rpc.call('slow.op', p, { signal: ac.signal })        // abortable
 *
 * Pairs with aurora's `command()` for reactive calls:
 *   const validate = command((p) => rpc.call('task.validate', p))
 */
import { HttpClient } from "./http.js";

export interface RpcClientOptions {
	/** Endpoint path. Default `/rpc` (matches RpcProvider's default). */
	url?: string;
	/** Reuse an existing HttpClient — its baseURL / headers / auth carry over. */
	http?: HttpClient;
	/** Default headers — only used when no `http` client is supplied. */
	headers?: Record<string, string>;
}

/** A JSON-RPC 2.0 error returned by the server (code + message + optional data). */
export class RpcError extends Error {
	readonly code: number;
	readonly data?: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "RpcError";
		this.code = code;
		this.data = data;
	}
}

/** Type guard for {@link RpcError}. */
export function isRpcError(value: unknown): value is RpcError {
	return value instanceof RpcError;
}

/** One call in a batch. `parse` optionally validates that call's result (cast-free). */
export interface RpcCall<T = unknown> {
	method: string;
	params?: unknown;
	parse?: (data: unknown) => T;
}

/** Per-call options for {@link RpcClient.call}. */
export interface RpcCallOptions<T = unknown> {
	/**
	 * Validate the result at runtime, returning the typed value — skips the
	 * unchecked `T` assertion (the cast-free escape hatch).
	 */
	parse?: (data: unknown) => T;
	/** Abort signal — abort it to cancel the request (e.g. on unmount / new keystroke). */
	signal?: AbortSignal;
}

/** A settled batch entry — the result, or the JSON-RPC error for that call. */
export type RpcResult<T = unknown> =
	| { ok: true; value: T }
	| { ok: false; error: RpcError };

export interface RpcClient {
	/**
	 * Call one method. Returns the result, or throws {@link RpcError} on a
	 * JSON-RPC error. The `jsonrpc`/`id` envelope is handled internally. Pass
	 * `options.parse` to validate the result at runtime (skips the unchecked `T`
	 * assertion) and `options.signal` to make the call abortable.
	 */
	call<T = unknown>(
		method: string,
		params?: unknown,
		options?: RpcCallOptions<T>,
	): Promise<T>;
	/**
	 * Send a JSON-RPC batch. Returns one settled entry per call, in request
	 * order. `options.signal` aborts the whole batch (it is one HTTP request).
	 */
	batch(
		calls: RpcCall[],
		options?: { signal?: AbortSignal },
	): Promise<RpcResult[]>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Turn a JSON-RPC `error` member into an {@link RpcError}. */
function toRpcError(error: unknown): RpcError {
	if (
		isObject(error) &&
		typeof error.code === "number" &&
		typeof error.message === "string"
	) {
		return new RpcError(error.code, error.message, error.data);
	}
	return new RpcError(-32603, "Malformed JSON-RPC error envelope", error);
}

export function createRpcClient(options: RpcClientOptions = {}): RpcClient {
	const http = options.http ?? new HttpClient({ headers: options.headers });
	const url = options.url ?? "/rpc";
	let nextId = 0;

	return {
		async call<T>(
			method: string,
			params?: unknown,
			options?: RpcCallOptions<T>,
		): Promise<T> {
			const id = ++nextId;
			const res = await http.post<unknown>(
				url,
				{ jsonrpc: "2.0", method, params, id },
				{ signal: options?.signal },
			);
			if (!isObject(res)) {
				throw new RpcError(
					-32603,
					`Malformed JSON-RPC response for "${method}"`,
				);
			}
			if (res.error !== undefined) throw toRpcError(res.error);
			// Result boundary — the same unchecked `T` assertion HttpClient uses,
			// with `parse` as the cast-free, runtime-validated escape hatch.
			return options?.parse ? options.parse(res.result) : (res.result as T);
		},

		async batch(
			calls: RpcCall[],
			options?: { signal?: AbortSignal },
		): Promise<RpcResult[]> {
			if (calls.length === 0) return [];
			const requests = calls.map((c, index) => ({
				jsonrpc: "2.0",
				method: c.method,
				params: c.params,
				id: index, // index = request position; responses are matched back by id
			}));
			const res = await http.post<unknown>(url, requests, {
				signal: options?.signal,
			});
			if (!Array.isArray(res)) {
				throw new RpcError(-32603, "Malformed JSON-RPC batch response");
			}
			const byId = new Map<unknown, Record<string, unknown>>();
			for (const item of res) if (isObject(item)) byId.set(item.id, item);
			return calls.map((c, index) => {
				const envelope = byId.get(index);
				if (!envelope) {
					return {
						ok: false,
						error: new RpcError(-32603, `No response for "${c.method}"`),
					};
				}
				if (envelope.error !== undefined) {
					return { ok: false, error: toRpcError(envelope.error) };
				}
				const value = c.parse ? c.parse(envelope.result) : envelope.result;
				return { ok: true, value };
			});
		},
	};
}
