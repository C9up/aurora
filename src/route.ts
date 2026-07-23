/**
 * `auroraRoute` — Ream route handler that SSR-renders an aurora
 * component and ships the markup plus the bytes needed for client-side
 * hydration.
 *
 * Usage:
 *
 *   import { auroraRoute } from '@c9up/aurora/provider'
 *   router.get('/dashboard', auroraRoute({
 *     entry: '/app/pages/dashboard.client.js',
 *     render: () => Dashboard({ user: ... })
 *   }))
 *
 * The handler:
 *   1. invokes `render()` and stringifies the result via @c9up/aurora's SSR
 *   2. wraps the markup in the page shell from `shell` (default: a minimal
 *      <!doctype html> document)
 *   3. embeds a `<script type="module">` that imports the user-supplied
 *      `entry` module — the client bundle is expected to call
 *      `hydrate(document.getElementById('aurora-root'), factory)` itself.
 */

import { renderToString } from "./ssr.js";
import type { TemplateResult } from "./types.js";

/**
 * Structural slice of Ream's HttpContext — the response surface we need.
 * Declaring it locally keeps aurora's bundle free of a `@c9up/ream`
 * import; any framework whose context exposes `response.header()` and
 * `response.send()` satisfies this contract via structural subtyping.
 */
export interface AuroraResponse {
	status(code: number): AuroraResponse;
	header(name: string, value: string): AuroraResponse;
	send(data: string): void;
}
export interface AuroraHttpContext {
	request: unknown;
	response: AuroraResponse;
}

/** Configuration for a single auroraRoute call. */
export interface AuroraRouteConfig {
	/**
	 * SSR factory. Called once per request. Returning a TemplateResult is
	 * the common case; returning a Promise<TemplateResult> works too
	 * (data-loading components).
	 */
	render: (ctx: AuroraHttpContext) => TemplateResult | Promise<TemplateResult>;
	/**
	 * Path to the ES module the browser should import to hydrate. The
	 * value is inlined into a `<script type="module" src="...">` tag —
	 * make sure the route exists on the Ream router (typically served
	 * statically). Defaults to `/aurora-client.js`.
	 */
	entry?: string;
	/**
	 * Page shell. Defaults to a minimal HTML5 doctype with a `<div
	 * id="aurora-root">` that wraps the SSR markup. Apps swap in their
	 * own to control `<head>` (title, meta, fonts, css).
	 */
	shell?: (body: string, entry: string) => string;
}

const DEFAULT_SHELL = (body: string, entry: string): string =>
	`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Aurora</title>
</head>
<body>
<div id="aurora-root">${body}</div>
<script type="module" src="${escapeAttr(entry)}"></script>
</body>
</html>`;

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Build a Ream-compatible route handler that SSR-renders the given
 * factory and serves the full HTML document.
 */
export function auroraRoute(
	config: AuroraRouteConfig,
): (ctx: AuroraHttpContext) => Promise<void> {
	const entry = config.entry ?? "/aurora-client.js";
	const shell = config.shell ?? DEFAULT_SHELL;

	return async (ctx) => {
		const tree = await config.render(ctx);
		const body = renderToString(tree);
		const html = shell(body, entry);
		ctx.response.header("content-type", "text/html; charset=utf-8");
		ctx.response.send(html);
	};
}
