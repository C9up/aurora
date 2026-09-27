/**
 * Where a request will actually go.
 *
 * Three places used to answer this with their own regex, all of the shape
 * `/^[a-z][a-z\d+\-.]*:\/\//` — "does it start with a scheme". A protocol-relative
 * URL has no scheme and goes wherever it names, so `//evil.example/x` read as
 * relative and the client sent it the page's own credentials: the default Bearer,
 * the default Authorization header, and the CSRF token. `\\evil.example/x`,
 * `/\evil.example/x` and `\/evil.example/x` did the same, because browsers treat
 * a backslash in the authority position as a slash for http(s).
 *
 * No character rule replaces it here. Every one of those forms is caught by
 * asking the URL parser the question directly — resolve against a base whose
 * origin nothing else can be, and see whether the result kept it. That is the
 * same parser the browser will use for the request, so there is nothing left to
 * get subtly wrong, and an unparseable URL comes back foreign rather than safe.
 */

/**
 * A base whose origin is unreachable, so a URL resolving to it brought no
 * authority of its own. `.invalid` is reserved by RFC 2606 and never resolves.
 */
const PROBE_BASE = "https://aurora.invalid/";
const PROBE_ORIGIN = "https://aurora.invalid";

/**
 * Does `url` name its own host — so it decides where the request goes, whatever
 * the page or the client's `baseURL` say?
 *
 * True for a scheme, for `//host`, for the backslash spellings of it, and for
 * anything the parser refuses. False only for a URL that has no choice but to
 * resolve against its base.
 */
export function carriesOwnAuthority(url: string): boolean {
	try {
		return new URL(url, PROBE_BASE).origin !== PROBE_ORIGIN;
	} catch {
		return true;
	}
}

/** The page's origin, or null outside a browser. */
function pageOrigin(): string | null {
	if (typeof window === "undefined") return null;
	try {
		return new URL(window.location.href).origin;
	} catch {
		return null;
	}
}

/** `url`'s origin once resolved against `base` (or the page), or null. */
function originOf(url: string, base?: string): string | null {
	// `typeof`, not `window?.` — outside a browser `window` is not a declared
	// global at all, so the optional chain throws a ReferenceError instead of
	// answering undefined. And the read has to be inside the try with the rest.
	try {
		const against =
			base !== undefined && base !== ""
				? base
				: typeof window === "undefined"
					? undefined
					: window.location.href;
		return against === undefined
			? new URL(url).origin
			: new URL(url, against).origin;
	} catch {
		return null;
	}
}

/**
 * Will this request leave the origin its credentials belong to?
 *
 * A URL with no authority of its own resolves against the base or the page, so
 * it cannot leave — that one is answered without parsing anything. Everything
 * else is resolved and compared, and anything that cannot be resolved counts as
 * leaving: an origin we could not work out is not an origin we should hand a
 * token to.
 */
export function isCrossOriginRequest(url: string, baseURL: string): boolean {
	if (!carriesOwnAuthority(url)) return false;
	const target = originOf(url, baseURL);
	const reference = baseURL === "" ? pageOrigin() : originOf(baseURL);
	if (target === null || reference === null) return true;
	return target !== reference;
}

/**
 * Is this URL served by the page's own origin?
 *
 * The question is not "does it match the client's baseURL" — a client whose
 * baseURL IS a third-party API would pass that one. A CSRF token authenticates
 * the page's session; sending it anywhere else hands a working token to whoever
 * runs that host.
 *
 * Outside a browser there is no page and no cookie, so the answer is no.
 */
export function isSameOriginAsPage(url: string): boolean {
	const page = pageOrigin();
	if (page === null) return false;
	return originOf(url) === page;
}
