/// <reference lib="dom" />
// This file uses browser globals. The reference pulls the DOM lib in for
// THIS file whatever `lib` the consumer configured, so a Node app
// typechecking against our sources does not trip over `window` —
// `types: "./src/index.ts"` means every consumer reads them.
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
	/**
	 * Auto CSRF: read the `XSRF-TOKEN` cookie and echo it as `X-XSRF-TOKEN` on
	 * every call (Axios/Angular convention), so RPC POSTs pass blackhole's
	 * signed double-submit check when the route is cookie/session-authed. No-op
	 * outside the browser and when the cookie is absent. Default `true`.
	 * `/rpc` under a bearer (JWT) guard is CSRF-exempt, so the missing-cookie
	 * no-op is exactly right there too.
	 */
	xsrf?: boolean;
	/** Cookie to read the CSRF token from. Default `XSRF-TOKEN`. */
	xsrfCookieName?: string;
	/** Header to echo the CSRF token in. Default `X-XSRF-TOKEN`. */
	xsrfHeaderName?: string;
}

/**
 * Create a JSON-RPC client bound to aurora's HttpClient transport. Inherits the
 * supplied (or a fresh) HttpClient's base URL, auth headers, and timeouts, and
 * (by default) auto-attaches the `X-XSRF-TOKEN` CSRF header from the cookie.
 */
export function createRpcClient(options: RpcClientOptions = {}): RpcClient {
	const http =
		options.http ??
		new HttpClient({
			headers: options.headers,
			xsrf: options.xsrf,
			xsrfCookieName: options.xsrfCookieName,
			xsrfHeaderName: options.xsrfHeaderName,
		});
	return createCometRpcClient({
		url: options.url,
		// The header comes from the transport, which attaches it for every
		// request it sends. Adding it here as well meant a caller who passed
		// their own `http` got a client that read the cookie and one that did
		// not, depending on which constructor argument they used.
		transport: (url, body, { signal }) =>
			http.post<unknown>(url, body, { signal, xsrf: options.xsrf }),
	});
}
