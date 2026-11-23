/**
 * Aurora's errors, one per code. Every failure aurora raises carries a stable
 * `E_AURORA_<REASON>` code, so a caller branches on `error.code` or on
 * `instanceof errors.E_AURORA_…` rather than on a message: a message is prose
 * and is free to improve, a code is a contract.
 *
 * This module is imported by browser-side code as well as the server, so it
 * stays free of Node built-ins (`@c9up/flare` has none).
 */
import { createError, Exception } from "@c9up/flare";

/** How a message names a template slot. */
const SLOT = `\${}`;

/** A page name escapes the pages root — `..`, an absolute path, a NUL. */
export const E_AURORA_ILLEGAL_PAGE_NAME = createError<[string]>(
	"[aurora] illegal page name: %j",
	"E_AURORA_ILLEGAL_PAGE_NAME",
);

/** The resolved path lands outside the configured pages root. */
export const E_AURORA_PAGE_OUTSIDE_ROOT = createError<[string]>(
	'[aurora] page path "%s" resolves outside the pages root',
	"E_AURORA_PAGE_OUTSIDE_ROOT",
);

/** No file for this page name. */
export const E_AURORA_PAGE_NOT_FOUND = createError<[string, string]>(
	'[aurora] page "%s" not found at %s',
	"E_AURORA_PAGE_NOT_FOUND",
);

/** The page is on disk and its module graph refused to load. */
export const E_AURORA_PAGE_IMPORT_FAILED = createError<
	[string, string, string, string]
>(
	'[aurora] page "%s" loaded from %s but its module graph failed: %s%s',
	"E_AURORA_PAGE_IMPORT_FAILED",
);

/** The page module loaded but does not default-export a factory. */
export const E_AURORA_PAGE_INVALID_EXPORT = createError<[string]>(
	"[aurora] %s must default-export a page function",
	"E_AURORA_PAGE_INVALID_EXPORT",
);

/** `renderPage` was given a root tag that is not a plain element name. */
export const E_AURORA_ILLEGAL_ROOT_TAG = createError<[string]>(
	"[aurora] illegal root tag: %j",
	"E_AURORA_ILLEGAL_ROOT_TAG",
);

/** `onMount` / `onUnmount` called outside a `component()` setup function. */
export const E_AURORA_OUTSIDE_COMPONENT = createError(
	"[aurora] onMount / onUnmount called outside component() — only valid inside a component setup function.",
	"E_AURORA_OUTSIDE_COMPONENT",
);

/** `inject` found no provider for the context, and it declared no default. */
export const E_AURORA_MISSING_CONTEXT = createError<[string]>(
	'No value provided for context "%s". Either this component is used outside the one that provides it, or that one built its children outside its own setup — a provider must read its children itself, inside setup, or they are created before it exists.',
	"E_AURORA_MISSING_CONTEXT",
);

/** The manager singleton was read before a provider or `setAurora` set it. */
export const E_AURORA_NOT_BOOTED = createError(
	"[aurora] AuroraManager singleton accessed before AuroraProvider.boot() ran or `setAurora(myManager)` was called. Wire one of them first.",
	"E_AURORA_NOT_BOOTED",
);

/** `urlFor` was given a name absent from the route manifest. */
export const E_AURORA_UNKNOWN_ROUTE = createError<[string, string]>(
	"[aurora] urlFor: unknown route '%s'. %s",
	"E_AURORA_UNKNOWN_ROUTE",
);

/** `urlFor` was given a route whose required params were not all supplied. */
export const E_AURORA_MISSING_ROUTE_PARAMS = createError<[string, string]>(
	"[aurora] urlFor: route '%s' is missing params %s",
	"E_AURORA_MISSING_ROUTE_PARAMS",
);

/** A live component was mounted before `registry.define()` named it. */
export const E_AURORA_UNKNOWN_LIVE_COMPONENT = createError<[string, string]>(
	'[aurora:live] unknown live component "%s" — register it with registry.define("%s", …) before mounting.',
	"E_AURORA_UNKNOWN_LIVE_COMPONENT",
);

/** A live session was refused: the registry holds `maxSessions` already. */
export const E_AURORA_LIVE_SESSION_LIMIT = createError<[number, string]>(
	'[aurora:live] the registry holds %d sessions, its maxSessions — refusing to mount "%s". Answer 503 and let the client retry.',
	"E_AURORA_LIVE_SESSION_LIMIT",
	503,
);

/** A relay request came back with a non-2xx status. */
export const E_AURORA_RELAY_REQUEST_FAILED = createError<[number, string]>(
	"[aurora:relay] HTTP %d%s",
	"E_AURORA_RELAY_REQUEST_FAILED",
);

/** A navigation URL failed the same-origin / scheme check. */
export const E_AURORA_UNSAFE_URL = createError<[string]>(
	"[aurora] blocked unsafe navigation URL: %s",
	"E_AURORA_UNSAFE_URL",
);

/** A `${}` landed where a tag name goes — `html`<${tag}>`` . */
export const E_AURORA_SLOT_IN_TAG_NAME = createError(
	`[aurora] a ${SLOT} cannot be a tag name — write the tag out, or pick between two templates.`,
	"E_AURORA_SLOT_IN_TAG_NAME",
);

/** A `${}` landed where an attribute name goes — `html`<img ${name}="v">`` . */
export const E_AURORA_SLOT_IN_ATTRIBUTE_NAME = createError(
	`[aurora] a ${SLOT} cannot be an attribute name — write the attribute out, or bind its value.`,
	"E_AURORA_SLOT_IN_ATTRIBUTE_NAME",
);

/**
 * A `${}` landed inside `<script>`, `<style>`, `<textarea>`, `<title>`…, or a
 * `.text` / `.textContent` binding wrote such an element's source. The text
 * depends on the element and the binding, so the site builds it.
 */
export const E_AURORA_SLOT_IN_RAW_TEXT = createError<[string]>(
	"%s",
	"E_AURORA_SLOT_IN_RAW_TEXT",
);

/** A `${}` landed inside a comment, a `<!…>`/`<?…>` or a CDATA section. */
export const E_AURORA_SLOT_IN_COMMENT = createError(
	`[aurora] a ${SLOT} cannot go inside an HTML comment, a <!…> or <?…> declaration or a CDATA section — it binds nothing there, and the marker aurora writes for it would end the comment early. Move it out of the comment.`,
	"E_AURORA_SLOT_IN_COMMENT",
);

/** A `${}` landed in an `on*` attribute, whose value is JavaScript. */
export const E_AURORA_SLOT_IN_EVENT_ATTRIBUTE = createError<[string, string]>(
	`[aurora] a ${SLOT} cannot go in "%s" — that value is JavaScript, and escaping it as HTML does not stop it running. Use @%s=\${handler}, which binds a function instead of writing source.`,
	"E_AURORA_SLOT_IN_EVENT_ATTRIBUTE",
);

/** A `${}` landed in `srcdoc`, which an iframe parses as a whole document. */
export const E_AURORA_SLOT_IN_SRCDOC = createError(
	`[aurora] a ${SLOT} cannot go in "srcdoc" — the iframe decodes that value and parses it as a whole HTML document, so escaping it protects nothing. Point the iframe at a URL you serve.`,
	"E_AURORA_SLOT_IN_SRCDOC",
);

/**
 * A `${}` landed in `<base href>`, which rebases every URL on the page. No
 * scheme check covers it: an `https://` base on another origin is the attack.
 */
export const E_AURORA_SLOT_IN_BASE_URL = createError(
	`[aurora] a ${SLOT} cannot go in <base href> — it rebases every relative URL on the page, the scripts it loads included, so any value but the one you meant hands the page to whoever chose it. Write the base URL into the template.`,
	"E_AURORA_SLOT_IN_BASE_URL",
);

/** A `${}` landed in the URL a `<script>` loads its code from. */
export const E_AURORA_SLOT_IN_SCRIPT_SOURCE = createError<[string]>(
	"[aurora] %s on <script> — whatever URL it holds is loaded and run with the page's authority, and no check on the value can tell the script you meant from one the value picked. Write the URL into the template; a script chosen at runtime is a decision for code that creates the element itself.",
	"E_AURORA_SLOT_IN_SCRIPT_SOURCE",
);

/** A `.prop` binding names a property that parses its value as HTML. */
export const E_AURORA_SLOT_IN_HTML_PROPERTY = createError<[string]>(
	"[aurora] cannot bind .%s — it parses its value as HTML, so the value runs as markup, handlers and all. Put the content in the template as a text slot, or pass a nested html`…` template.",
	"E_AURORA_SLOT_IN_HTML_PROPERTY",
);

/** A nested `html` template reached an attribute value or `.value`. */
export const E_AURORA_TEMPLATE_IN_ATTRIBUTE = createError(
	"[aurora] a nested html`…` template cannot be an attribute value or a .value — markup has no meaning there. Pass a string; for a prop typed string | template, bind the string form to the attribute.",
	"E_AURORA_TEMPLATE_IN_ATTRIBUTE",
);

/** `.value` was given a non-empty string on an `<input type="file">`. */
export const E_AURORA_FILE_INPUT_VALUE = createError<[string]>(
	'[aurora] cannot set .value on <input type="file"> to "%s" — a file input\'s value is whatever the user picked, and a script may only clear it. Bind "" to reset the field, or drop the .value binding.',
	"E_AURORA_FILE_INPUT_VALUE",
);

/** Two elements of an `each()` list share a key, which names one row. */
export const E_AURORA_DUPLICATE_KEY = createError<[string]>(
	"[aurora] each(): two elements share the key %s — a key names one row",
	"E_AURORA_DUPLICATE_KEY",
);

/** `each(…, { lazy })` with an estimate or overscan that is not a usable length. */
export const E_AURORA_INVALID_LAZY = createError<[string, string, string]>(
	"[aurora] each(): lazy.%s must be %s, got %s",
	"E_AURORA_INVALID_LAZY",
);

/**
 * `visits` is on but `@c9up/photon` is missing, or too old to speak its
 * protocol for aurora. The text names what is missing, so the site builds it.
 */
export const E_AURORA_VISITS_NEED_PHOTON = createError<[string]>(
	"[aurora] %s",
	"E_AURORA_VISITS_NEED_PHOTON",
);

/** With `visits` on, a page's props (shared ones merged in) were not a plain object, as the protocol requires. */
export const E_AURORA_VISIT_PROPS = createError<[string, string]>(
	'[aurora] page "%s": with visits on, props must be an object (the protocol\'s page.props), got %s',
	"E_AURORA_VISIT_PROPS",
);

/**
 * `motion=${…}` was not an object of motion values, or named a property
 * motion cannot drive (rotation, colour).
 */
export const E_AURORA_INVALID_MOTION = createError<[string]>(
	"[aurora] %s",
	"E_AURORA_INVALID_MOTION",
);

/** Effects kept re-running each other: one writes what another (or itself) reads, forever. */
export const E_AURORA_REACTIVE_CYCLE = createError<[number]>(
	"[aurora] effects re-ran more than %d times in one update — an effect writes a signal that it, or an effect it triggers, reads",
	"E_AURORA_REACTIVE_CYCLE",
);

/** With `visits` on, the page carries no usable `aurora-page-data` to boot from. */
export const E_AURORA_VISIT_NO_PAGE_DATA = createError(
	"[aurora] visits: the page carries no aurora-page-data to boot from",
	"E_AURORA_VISIT_NO_PAGE_DATA",
);

/** With `visits` on, the first page's factory is async: a hydrated page renders synchronously. */
export const E_AURORA_VISIT_ASYNC_FIRST_PAGE = createError(
	"[aurora] visits: the first page's factory is async; a hydrated page has to render synchronously",
	"E_AURORA_VISIT_ASYNC_FIRST_PAGE",
);

/** A live registry limit (`maxSessions`, a timeout…) that is not a positive number. */
export const E_AURORA_INVALID_LIVE_LIMIT = createError<[string, string]>(
	"[aurora:live] %s must be a positive number, got %s.",
	"E_AURORA_INVALID_LIVE_LIMIT",
);

/** A browser package declares its entry outside the `dist/` aurora serves for it. */
export const E_AURORA_BROWSER_ENTRY_OUTSIDE_DIST = createError<
	[string, string, string]
>(
	'[aurora] "%s" declares its browser entry at "%s", outside the directory aurora serves for it ("%s"). Map it yourself with `importmap` in config/aurora.ts, or ship the entry under dist/.',
	"E_AURORA_BROWSER_ENTRY_OUTSIDE_DIST",
);

/** A browser package has its entry at the package root: serving it would publish the whole package. */
export const E_AURORA_BROWSER_ENTRY_AT_ROOT = createError<[string, string]>(
	'[aurora] "%s" has its entry at the package root ("%s"), so serving it would publish the whole package. Leave it out of browserPackages and map it with `importmap` in config/aurora.ts, onto a mount of just the files the browser needs.',
	"E_AURORA_BROWSER_ENTRY_AT_ROOT",
);

/** Two browser packages would mount on the same asset path. */
export const E_AURORA_BROWSER_PACKAGE_CLASH = createError<
	[string, string, string]
>(
	'[aurora] browser packages "%s" and "%s" both mount on "%s" — one would be unreachable. Rename one, or serve it yourself.',
	"E_AURORA_BROWSER_PACKAGE_CLASH",
);

/**
 * An `HttpClient` request came back with a non-2xx status. Carries the
 * `Response` and its parsed body; `status` is the response's.
 */
export class E_AURORA_HTTP_REQUEST_FAILED extends Exception {
	static override code = "E_AURORA_HTTP_REQUEST_FAILED";
	static override message = "HTTP request failed";

	/** The response that came back. */
	readonly response: Response;
	/** Its parsed body: JSON when it was JSON, else the text. */
	readonly data: unknown;

	constructor(response: Response, data: unknown, options?: ErrorOptions) {
		super(
			`HTTP ${response.status} ${response.statusText} for ${response.url}`,
			{ ...options, status: response.status },
		);
		this.response = response;
		this.data = data;
	}
}

/**
 * An invariant inside aurora broke — always a bug in aurora itself. The site
 * says which one.
 */
export const E_AURORA_INTERNAL = createError<[string]>(
	"[aurora] %s",
	"E_AURORA_INTERNAL",
);
