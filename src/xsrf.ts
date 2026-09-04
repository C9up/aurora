/// <reference lib="dom" />
/**
 * Echoing the CSRF cookie back as a header, in one place.
 *
 * The signed double-submit guard on the server reads `XSRF-TOKEN` from the
 * cookie jar and compares it to `X-XSRF-TOKEN` on the request. A browser sends
 * the cookie on its own; the header is the client's half, and it is the half
 * that says "this request came from our own page", because a cross-site caller
 * can cause the cookie to ride along but cannot read it.
 *
 * This lived three times over. `rpc.ts` and `relay.ts` each had a copy, and
 * both described theirs as mirroring `HttpClient.#retrieveXsrfToken` — a method
 * `HttpClient` never had. So the client the docs tell you to submit a form with
 * sent no header at all, and every POST through it was refused the moment an
 * application turned CSRF on. One reader now, used by all three.
 */

/** The cookie the server seeds. */
export const XSRF_COOKIE_NAME = "XSRF-TOKEN";

/** The header it is echoed in (the Axios/Angular convention the server reads). */
export const XSRF_HEADER_NAME = "X-XSRF-TOKEN";

/** Per-client switches for the automatic header. */
export interface XsrfOptions {
	/**
	 * Echo the CSRF cookie as a header on same-origin requests. Default `true`.
	 * A no-op outside a browser and when the cookie is absent — a bearer-authed
	 * API is CSRF-exempt and seeds no cookie, so nothing is sent there either.
	 */
	xsrf?: boolean;
	/** Cookie to read the token from. Default `XSRF-TOKEN`. */
	xsrfCookieName?: string;
	/** Header to echo it in. Default `X-XSRF-TOKEN`. */
	xsrfHeaderName?: string;
}

/**
 * Read a cookie's raw value from `document.cookie`.
 *
 * Verbatim, never decoded: the server compares the header to the cookie
 * byte-for-byte. The token is hex + `.` + base64url, so there is nothing a
 * decode could change — but a decode that ever did change something would turn
 * a valid request into a rejected one, silently.
 *
 * Returns `undefined` server-side (no `document`) or when the cookie is absent.
 */
export function readXsrfCookie(
	name: string = XSRF_COOKIE_NAME,
): string | undefined {
	if (typeof document === "undefined") return undefined;
	const prefix = `${name}=`;
	for (const part of document.cookie.split(";")) {
		const trimmed = part.trimStart();
		if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
	}
	return undefined;
}

/**
 * Is this URL served by the page's own origin?
 *
 * The question is not "does it match the client's baseURL" — a client whose
 * baseURL IS a third-party API would pass that one. A CSRF token authenticates
 * the page's session; sending it anywhere else hands a working token to whoever
 * runs that host.
 *
 * A relative URL is same-origin by construction. Outside a browser there is no
 * page and no cookie, so the answer is no.
 */
export function isSameOriginAsPage(url: string): boolean {
	if (typeof window === "undefined") return false;
	if (!/^[a-z][a-z\d+\-.]*:\/\//i.test(url)) return true;
	try {
		return new URL(url).origin === window.location.origin;
	} catch {
		return false;
	}
}

/**
 * The header to add for `url`, or `undefined` when there is nothing to send.
 *
 * Absent cookie, disabled, cross-origin target, or no browser: nothing. The
 * caller merges the result rather than being handed an empty object, so a call
 * site cannot accidentally overwrite a header it set itself.
 */
export function xsrfHeaderFor(
	url: string,
	options: XsrfOptions = {},
): Record<string, string> | undefined {
	if (options.xsrf === false) return undefined;
	if (!isSameOriginAsPage(url)) return undefined;
	const token = readXsrfCookie(options.xsrfCookieName ?? XSRF_COOKIE_NAME);
	if (token === undefined) return undefined;
	return { [options.xsrfHeaderName ?? XSRF_HEADER_NAME]: token };
}
