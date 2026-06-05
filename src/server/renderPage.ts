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
 *       { "imports": { "@c9up/aurora": "/_assets/aurora/index.js" } }
 *     </script>
 *   </head>
 *   <body>
 *     <div id="aurora-root">…SSR markup…</div>
 *     <script id="aurora-page-data" type="application/json">{…}</script>
 *     <script type="module">
 *       import { hydrate } from '@c9up/aurora'
 *       import Page from '/_assets/pages/ProjectPage.js'
 *       const data = JSON.parse(document.getElementById('aurora-page-data').textContent)
 *       hydrate(document.getElementById('aurora-root'), () => Page(data.props))
 *     </script>
 *   </body>
 */

import type { Pages } from "../Pages.js";
import { renderToString } from "../ssr.js";

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
	 * `@c9up/aurora` to `/_assets/aurora/index.js`. Override to point
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
}

export async function renderPage<P>(
	ctx: RenderHttpContext,
	pages: Pages,
	name: string,
	props: P,
	options: RenderPageOptions = {},
): Promise<void> {
	const factory = await pages.resolve(name);
	// The factory must be invoked the SAME way client-side for hydrate
	// to find matching slots — `Page(props)` is the contract.
	const tree = await factory(props as never);
	const body = renderToString(tree);

	const importmap = {
		"@c9up/aurora": "/_assets/aurora/index.js",
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
<script type="importmap">${JSON.stringify({ imports: importmap })}</script>
${options.headExtra ?? ""}
</head>
<body>
<div id="${escapeAttr(rootId)}">${body}</div>
<script id="aurora-page-data" type="application/json">${escapeJsonForScript({
		name,
		props,
		url: pageUrl,
		rootId,
	})}</script>
<script type="module">
import { hydrate } from '@c9up/aurora'
import Page from ${JSON.stringify(pageUrl)}
const data = JSON.parse(document.getElementById('aurora-page-data').textContent)
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
