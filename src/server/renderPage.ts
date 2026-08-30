/**
 * `renderPage` — server-side helper that turns a page name + props into
 * a full HTML document, ready to ship from a route handler.
 *
 * The output carries everything the browser needs to hydrate against
 * the SSR markup with zero app-side scripting:
 *
 *   <head>
 *     ...
 *     <script type="importmap">
 *       { "imports": { "@c9up/aurora": "/__assets/aurora/index.js" } }
 *     </script>
 *   </head>
 *   <body>
 *     <div id="aurora-root">…SSR markup…</div>
 *     <script id="aurora-page-data" type="application/json">{…}</script>
 *     <script type="module">
 *       import { hydrate } from '@c9up/aurora'
 *       import Page from '/__assets/pages/ProjectPage.js'
 *       const data = JSON.parse(document.getElementById('aurora-page-data').textContent)
 *       hydrate(document.getElementById('aurora-root'), () => Page(data.props))
 *     </script>
 *   </body>
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { setCookieStoreReader } from "../browser.js";
import type { Pages } from "../Pages.js";
import { renderToString } from "../ssr.js";
import { setRouteManifestReader } from "../url.js";

/**
 * Structural slice of the host framework's response. Same shape
 * `auroraRoute()` uses — keeps aurora free of a `@c9up/ream` import.
 */
export interface RenderResponse {
	status(code: number): RenderResponse;
	header(name: string, value: string): RenderResponse;
	send(body: string): void;
	/**
	 * Per-request CSP nonce, when a security layer set one.
	 *
	 * `@c9up/blackhole` seeds it on the response (the AdonisJS idiom,
	 * `response.nonce`) whenever the policy uses `@nonce`. Optional, and read
	 * structurally: aurora stays free of any dependency on it, and a host that
	 * sets no policy renders exactly as before.
	 */
	nonce?: string;
}
export interface RenderHttpContext {
	request: unknown;
	response: RenderResponse;
	/** Per-request bag; blackhole also seeds `cspNonce` here. */
	store?: { get(key: string): unknown };
}

export interface RenderPageOptions {
	/**
	 * CSP nonce for the inline scripts this page emits.
	 *
	 * Normally left unset: it is read from `response.nonce` (what blackhole
	 * seeds) or from the request store. Pass it only when the security layer
	 * puts it somewhere else. It must be the SAME nonce the policy header
	 * names, otherwise the browser blocks the scripts anyway.
	 */
	nonce?: string;
	/**
	 * Importmap entries injected into `<head>`. Defaults to mapping
	 * `@c9up/aurora` to `/__assets/aurora/index.js`. Override to point
	 * at a different mount or to add app-side aliases.
	 */
	importmap?: Record<string, string>;
	/**
	 * Extra markup spliced into `<head>` after the importmap. Use to
	 * inject `<title>`, meta tags, stylesheets.
	 *
	 * ⚠️ Injected RAW / unescaped — it IS `<head>` markup, so it cannot be
	 * HTML-escaped. Pass ONLY trusted, server-authored strings; NEVER
	 * interpolate request/user input into it (that is an HTML-injection
	 * sink). Build any dynamic head content through an escaping helper
	 * upstream before handing it here.
	 */
	headExtra?: string;
	/**
	 * Outer language tag on the `<html>` element. Defaults to `en`.
	 */
	lang?: string;
	/**
	 * Mount root id for the SSR + hydrated tree. Defaults to
	 * `aurora-root`. Matches the id the client-side hydrate script
	 * targets.
	 */
	rootId?: string;
	/**
	 * Root element tag for the SSR + hydrated tree. Defaults to `div`.
	 * Mirrors Inertia's root tag customization (`@inertia({ as: ... })`) while
	 * keeping aurora independent from a template engine.
	 */
	rootTag?: string;
	/**
	 * Optional class attribute on the root element. Mirrors
	 * `@inertia({ class: ... })`.
	 */
	rootClass?: string;
	/**
	 * Shared props merged into every page render before invoking the page factory.
	 * Use this for global data such as user, flash and validation errors. A
	 * function receives the current HTTP context and may be async, matching
	 * Adonis/Inertia's request middleware `share()` model.
	 */
	shared?: SharedProps | SharedPropsResolver;
	/**
	 * Asset/version marker serialized with the page payload. Apps can use this to
	 * detect stale client state when their frontend build changes.
	 */
	assetsVersion?: string;
	/**
	 * Named-route manifest (`name → path-pattern`) for the isomorphic
	 * `urlFor()` helper — build it with Ream's `router.namedManifest()`. It is
	 * installed server-side before the page renders AND serialized into the page
	 * so the hydrate bootstrap re-installs it, making `urlFor` work identically
	 * in SSR and the browser. Omit if the app doesn't use `urlFor`.
	 */
	routes?: Record<string, string>;
	/**
	 * Allowlist of cookie names to seed into the SSR cookie store so a page can
	 * read them during render via aurora's `cookieSignal` / `cookie.get` — the
	 * server then renders the SAME UI state the browser will (no hydration flash
	 * of the default, e.g. a sidebar animating open→collapsed on every load).
	 *
	 * Only the NAMED cookies are read (from `ctx.request`); they are NOT
	 * serialized into the page — the browser reads them from `document.cookie`.
	 * NEVER list a session / signed / encrypted / `httpOnly` cookie here: those
	 * must stay server-only. Use plain, JS-readable cookies for UI state.
	 */
	cookies?: string[];
}

export type SharedProps = Record<string, unknown>;
export type SharedPropsResolver = (
	ctx: RenderHttpContext,
) => SharedProps | Promise<SharedProps>;

/** A request that can read a cookie by name — the structural slice we need. */
/**
 * The slice of a host request this needs: reading a cookie the browser wrote.
 *
 * `plainCookie` is the one to use. These cookies are written client-side
 * through `document.cookie`, so they carry no signature; a host whose
 * `cookie()` verifies one (as Ream's does) returns nothing for them, and the
 * seed silently empties — which is the flash this exists to prevent.
 *
 * `cookie` is accepted as a fallback so a host that only offers that spelling
 * still seeds, rather than rendering default state and saying nothing.
 */
interface CookieReadableRequest {
	plainCookie?<T = string>(
		name: string,
		defaultValue?: T,
		options?: { encoded?: boolean },
	): T | null;
	cookie?(name: string): string | null;
}

interface RenderScope {
	cookies: Record<string, string>;
	routes: Record<string, string>;
}

const renderScope = new AsyncLocalStorage<RenderScope>();

setCookieStoreReader(() => renderScope.getStore()?.cookies);
setRouteManifestReader(() => renderScope.getStore()?.routes);

function isCookieReadable(request: unknown): request is CookieReadableRequest {
	if (typeof request !== "object" || request === null) return false;
	return (
		typeof Reflect.get(request, "plainCookie") === "function" ||
		typeof Reflect.get(request, "cookie") === "function"
	);
}

/** Read the allowlisted cookies off the request into a `name → value` seed. */
function readRequestCookies(
	request: unknown,
	names: string[],
): Record<string, string> {
	if (!isCookieReadable(request)) return {};
	const seed: Record<string, string> = {};
	// Unsigned first; `cookie()` only when the host offers nothing else.
	const read = request.plainCookie
		? (name: string) =>
				request.plainCookie?.<string>(name, undefined, { encoded: false })
		: (name: string) => request.cookie?.(name);
	for (const name of names) {
		const value = read(name);
		if (value !== null && value !== undefined) seed[name] = value;
	}
	return seed;
}

export async function renderPage<P>(
	ctx: RenderHttpContext,
	pages: Pages,
	name: string,
	props: P,
	options: RenderPageOptions = {},
): Promise<void> {
	const scope: RenderScope = {
		cookies: options.cookies
			? readRequestCookies(ctx.request, options.cookies)
			: {},
		routes: options.routes ?? {},
	};

	return renderScope.run(scope, () =>
		renderPageInScope(ctx, pages, name, props, options),
	);
}

async function renderPageInScope<P>(
	ctx: RenderHttpContext,
	pages: Pages,
	name: string,
	props: P,
	options: RenderPageOptions,
): Promise<void> {
	const factory = await pages.resolve(name);
	const shared = await resolveSharedProps(ctx, options.shared);
	const pageProps = mergeProps(shared, props);
	// The factory must be invoked the SAME way client-side for hydrate
	// to find matching slots — `Page(props)` is the contract.
	const tree = await factory(pageProps as never);
	const body = renderToString(tree);

	const importmap = {
		"@c9up/aurora": "/__assets/aurora/index.js",
		...options.importmap,
	};
	const rootId = options.rootId ?? "aurora-root";
	const rootTag = normalizeRootTag(options.rootTag ?? "div");
	const rootClass = options.rootClass;
	const lang = options.lang ?? "en";
	const pageUrl = pages.urlFor(name);

	// A CSP that names a nonce blocks every inline script that lacks it, and the
	// page then renders but never hydrates — the HTML is byte-identical, so only
	// a real browser shows the failure. Reading it here is what lets a default
	// policy stay strict instead of being turned off.
	const nonce = resolveNonce(ctx, options.nonce);
	const nonceAttr = nonce === undefined ? "" : ` nonce="${escapeAttr(nonce)}"`;

	const doc = `<!doctype html>
<html lang="${escapeAttr(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<script${nonceAttr} type="importmap">${escapeJsonForScript({ imports: importmap })}</script>
${options.headExtra ?? ""}
</head>
<body>
<${rootTag}${rootAttrs(rootId, rootClass)}>${body}</${rootTag}>
<script${nonceAttr} id="aurora-page-data" type="application/json">${escapeJsonForScript(
		{
			name,
			props: pageProps,
			url: pageUrl,
			rootId,
			routes: options.routes ?? {},
			version: options.assetsVersion ?? null,
		},
	)}</script>
<script${nonceAttr} type="module">
import { hydrate, setRouteManifest } from '@c9up/aurora'
import Page from ${JSON.stringify(pageUrl)}
const data = JSON.parse(document.getElementById('aurora-page-data').textContent)
setRouteManifest(data.routes ?? {})
hydrate(document.getElementById(data.rootId), () => Page(data.props))
</script>
</body>
</html>`;

	ctx.response.header("content-type", "text/html; charset=utf-8");
	ctx.response.send(doc);
}

/**
 * The nonce to stamp on inline scripts, or `undefined` when there is none.
 *
 * Explicit option first, then `response.nonce` (what AdonisJS exposes and what
 * blackhole seeds), then the `cspNonce` a middleware may have left in the
 * per-request store. Never generated here: a nonce aurora invented would not
 * appear in the policy header, so it would block the page rather than unblock
 * it.
 */
function resolveNonce(
	ctx: RenderHttpContext,
	explicit?: string,
): string | undefined {
	if (typeof explicit === "string" && explicit.length > 0) return explicit;
	const fromResponse = ctx.response.nonce;
	if (typeof fromResponse === "string" && fromResponse.length > 0)
		return fromResponse;
	const fromStore = ctx.store?.get("cspNonce");
	if (typeof fromStore === "string" && fromStore.length > 0) return fromStore;
	return undefined;
}

async function resolveSharedProps(
	ctx: RenderHttpContext,
	shared: RenderPageOptions["shared"],
): Promise<SharedProps> {
	if (!shared) return {};
	return typeof shared === "function" ? shared(ctx) : shared;
}

function mergeProps<P>(shared: SharedProps, props: P): P | SharedProps {
	if (Object.keys(shared).length === 0) return props;
	if (isPlainRecord(props)) return { ...shared, ...props };
	return { ...shared, page: props };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function normalizeRootTag(tag: string): string {
	if (/^[a-z][a-z0-9-]*$/i.test(tag)) return tag.toLowerCase();
	throw new Error(`[aurora] illegal root tag: ${JSON.stringify(tag)}`);
}

function rootAttrs(id: string, className: string | undefined): string {
	const attrs = [`id="${escapeAttr(id)}"`];
	if (className) attrs.push(`class="${escapeAttr(className)}"`);
	return ` ${attrs.join(" ")}`;
}

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;");
}

/**
 * Escape a JSON payload for safe embedding inside a `<script>` block.
 *
 * The HTML parser ends the script on `</script>` and reinterprets `<!--` /
 * `-->` as comment markers, whatever the JSON quoting says — so those
 * characters must not survive literally. They are escaped as \uXXXX, which is
 * valid JSON: a backslash escape like `\!` or `\>` is NOT, and made
 * `JSON.parse` throw on the client the moment a prop contained a comment
 * marker, taking the whole page's hydration with it.
 */
function escapeJsonForScript(value: unknown): string {
	return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => {
		switch (c) {
			case "<":
				return "\\u003c";
			case ">":
				return "\\u003e";
			case "&":
				return "\\u0026";
			// Line separators are valid in JSON strings but terminate a JS line,
			// so a script block carrying them raw is a syntax error.
			case "\u2028":
				return "\\u2028";
			default:
				return "\\u2029";
		}
	});
}
