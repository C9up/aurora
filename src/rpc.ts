/**
 * Browser JSON-RPC 2.0 client for Ream's RPC endpoint — aurora's thin binding
 * over the agnostic {@link https://github.com/C9up/comet | @c9up/comet} client.
 * It wires aurora's {@link HttpClient} (base URL, auth headers, timeouts) as
 * comet's transport, and re-exports the protocol surface so call sites keep
 * importing everything from `@c9up/aurora`.
 *
 *   const rpc = createRpcClient()                              // POST /rpc, same-origin
 *   const result = await rpc.call('task.validate', { id })     // typed via call<T>()
 *   const user = await rpc.call('user.find', { id }, { parse: isUser }) // validated, cast-free
 *   await rpc.call('slow.op', p, { signal: ac.signal })        // abortable
 *
 * Pairs with aurora's `command()` for reactive calls:
 *   const validate = command((p) => rpc.call('task.validate', p))
 */
import { createRpcClient as createCometRpcClient } from "@c9up/comet";
import { HttpClient } from "./http.js";

export {
	isRpcError,
	type RpcCall,
	type RpcCallOptions,
	type RpcClient,
	RpcError,
	type RpcResult,
} from "@c9up/comet";

import type { RpcClient } from "@c9up/comet";

export interface RpcClientOptions {
	/** Endpoint path. Default `/rpc` (matches RpcProvider's default). */
	url?: string;
	/** Reuse an existing HttpClient — its baseURL / headers / auth carry over. */
	http?: HttpClient;
	/** Default headers — only used when no `http` client is supplied. */
	headers?: Record<string, string>;
}

/**
 * Create a JSON-RPC client bound to aurora's HttpClient transport. Inherits the
 * supplied (or a fresh) HttpClient's base URL, auth headers, and timeouts.
 */
export function createRpcClient(options: RpcClientOptions = {}): RpcClient {
	const http = options.http ?? new HttpClient({ headers: options.headers });
	return createCometRpcClient({
		url: options.url,
		transport: (url, body, { signal }) =>
			http.post<unknown>(url, body, { signal }),
	});
}
