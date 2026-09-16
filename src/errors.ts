/**
 * Aurora's errors.
 *
 * Every failure aurora raises carries a stable `code`, so a caller can branch
 * on what went wrong without matching on a message — a message is prose and is
 * free to improve, a code is a contract. The cohort shape is
 * `E_<PACKAGE>_<REASON>`.
 *
 * This module is imported by browser-side code as well as the server, so it
 * stays free of Node built-ins.
 */

export type AuroraErrorCode =
	/** A page name escapes the pages root — `..`, an absolute path, a NUL. */
	| "E_AURORA_ILLEGAL_PAGE_NAME"
	/** The resolved path lands outside the configured pages root. */
	| "E_AURORA_PAGE_OUTSIDE_ROOT"
	/** No file for this page name. */
	| "E_AURORA_PAGE_NOT_FOUND"
	/** The page is on disk and its module graph refused to load. */
	| "E_AURORA_PAGE_IMPORT_FAILED"
	/** The page module loaded but does not default-export a factory. */
	| "E_AURORA_PAGE_INVALID_EXPORT"
	/** `renderPage` was given a root tag that is not a plain element name. */
	| "E_AURORA_ILLEGAL_ROOT_TAG"
	/** `onMount` / `onUnmount` called outside a `component()` setup function. */
	| "E_AURORA_OUTSIDE_COMPONENT"
	/** The manager singleton was read before a provider or `setAurora` set it. */
	| "E_AURORA_NOT_BOOTED"
	/** `urlFor` was given a name absent from the route manifest. */
	| "E_AURORA_UNKNOWN_ROUTE"
	/** `urlFor` was given a route whose required params were not all supplied. */
	| "E_AURORA_MISSING_ROUTE_PARAMS"
	/** A live component was mounted before `registry.define()` named it. */
	| "E_AURORA_UNKNOWN_LIVE_COMPONENT"
	/** A relay request came back with a non-2xx status. */
	| "E_AURORA_RELAY_REQUEST_FAILED"
	/** A navigation URL failed the same-origin / scheme check. */
	| "E_AURORA_UNSAFE_URL"
	/** An invariant inside aurora broke — always a bug in aurora itself. */
	| "E_AURORA_INTERNAL";

/**
 * Base class, so a caller can catch every aurora error by one name.
 *
 * `options` is the standard `ErrorOptions`, which is how `cause` reaches it:
 * wrapping a lower-level failure must never drop the stack that points at the
 * line responsible.
 */
export class AuroraError extends Error {
	readonly code: AuroraErrorCode;

	constructor(code: AuroraErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}
