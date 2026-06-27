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
 * Read a cookie's raw value from `document.cookie`. Returns `undefined`
 * server-side (no `document`) or when the cookie is absent. The value is sent
 * verbatim — double-submit compares it byte-for-byte against the cookie, so it
 * must not be decoded.
 */
function readCookie(name: string): string | undefined {
	if (typeof document === "undefined") return undefined;
	const prefix = `${name}=`;
	for (const part of document.cookie.split(";")) {
		const trimmed = part.trimStart();
		if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
	}
	return undefined;
}

/**
 * Create a JSON-RPC client bound to aurora's HttpClient transport. Inherits the
 * supplied (or a fresh) HttpClient's base URL, auth headers, and timeouts, and
 * (by default) auto-attaches the `X-XSRF-TOKEN` CSRF header from the cookie.
 */
export function createRpcClient(options: RpcClientOptions = {}): RpcClient {
	const http = options.http ?? new HttpClient({ headers: options.headers });
	const xsrfEnabled = options.xsrf ?? true;
	const cookieName = options.xsrfCookieName ?? "XSRF-TOKEN";
	const headerName = options.xsrfHeaderName ?? "X-XSRF-TOKEN";
	return createCometRpcClient({
		url: options.url,
		transport: (url, body, { signal }) => {
			let headers: Record<string, string> | undefined;
			if (xsrfEnabled) {
				const token = readCookie(cookieName);
				if (token !== undefined) headers = { [headerName]: token };
			}
			return http.post<unknown>(url, body, { signal, headers });
		},
	});
}
