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

import { setCookieStore } from "../browser.js";
import type { Pages } from "../Pages.js";
import { renderToString } from "../ssr.js";
import { setRouteManifest } from "../url.js";

/**
 * Structural slice of the host framework's response. Same shape
 * `auroraRoute()` uses — keeps aurora free of a `@c9up/ream` import.
 */
export interface RenderResponse {
	status(code: number): RenderResponse;
	header(name: string, value: string): RenderResponse;
	send(body: string): void;
}
export interface RenderHttpContext {
	request: unknown;
	response: RenderResponse;
}

export interface RenderPageOptions {
	/**
	 * Importmap entries injected into `<head>`. Defaults to mapping
	 * `@c9up/aurora` to `/__assets/aurora/index.js`. Override to point
	 * at a different mount or to add app-side aliases.
	 */
	importmap?: Record<string, string>;
	/**
	 * Extra markup spliced into `<head>` after the importmap. Use to
	 * inject `<title>`, meta tags, stylesheets.
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

/** A request that can read a cookie by name — the structural slice we need. */
interface CookieReadableRequest {
	cookie(name: string): string | null;
}

function isCookieReadable(request: unknown): request is CookieReadableRequest {
	return (
		typeof request === "object" &&
		request !== null &&
		"cookie" in request &&
		typeof request.cookie === "function"
	);
}

/** Read the allowlisted cookies off the request into a `name → value` seed. */
function readRequestCookies(
	request: unknown,
	names: string[],
): Record<string, string> {
	if (!isCookieReadable(request)) return {};
	const seed: Record<string, string> = {};
	for (const name of names) {
		const value = request.cookie(name);
		if (value !== null) seed[name] = value;
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
	// Install the route manifest BEFORE rendering so a page calling `urlFor`
	// during SSR resolves against the same map the client will get.
	if (options.routes) setRouteManifest(options.routes);

	// Seed the request's UI cookies so the page reads the SAME state server-side
	// that the browser will after hydration. Set synchronously right before the
	// (synchronous) render — read cookie signals at the top of the page.
	setCookieStore(
		options.cookies ? readRequestCookies(ctx.request, options.cookies) : {},
	);

	const factory = await pages.resolve(name);
	// The factory must be invoked the SAME way client-side for hydrate
	// to find matching slots — `Page(props)` is the contract.
	const tree = await factory(props as never);
	const body = renderToString(tree);

	const importmap = {
		"@c9up/aurora": "/__assets/aurora/index.js",
		...options.importmap,
	};
	const rootId = options.rootId ?? "aurora-root";
	const lang = options.lang ?? "en";
	const pageUrl = pages.urlFor(name);

	const doc = `<!doctype html>
<html lang="${escapeAttr(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<script type="importmap">${escapeJsonForScript({ imports: importmap })}</script>
${options.headExtra ?? ""}
</head>
<body>
<div id="${escapeAttr(rootId)}">${body}</div>
<script id="aurora-page-data" type="application/json">${escapeJsonForScript({
		name,
		props,
		url: pageUrl,
		rootId,
		routes: options.routes ?? {},
	})}</script>
<script type="module">
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

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;");
}

/**
 * Escape a JSON payload for safe embedding inside a `<script>` block.
 * The HTML parser closes the script on `</script>` regardless of JSON
 * quoting, so we slash-escape the `/`. We also escape `<!--` and `-->`
 * to dodge HTML-comment interpretation inside the script body.
 */
function escapeJsonForScript(value: unknown): string {
	return JSON.stringify(value)
		.replace(/<\/(script)/gi, "<\\/$1")
		.replace(/<!--/g, "<\\!--")
		.replace(/-->/g, "--\\>");
}
