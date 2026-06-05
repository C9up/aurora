// ─── Inertia-shape server surface ─────────────────────────────────
export { AuroraManager, type AuroraManagerConfig } from "./AuroraManager.js";
export { component, onMount, onUnmount } from "./component.js";
export { html, isTemplateResult } from "./html.js";
export { hydrate } from "./hydrate.js";
export {
	type PageFactory,
	Pages,
	type PagesConfig,
} from "./Pages.js";
export {
	batch,
	effect,
	isSignal,
	memo,
	onCleanup,
	type ReadSignal,
	type Signal,
	signal,
	untrack,
} from "./reactive.js";
export { type Disposer, render } from "./render.js";
export {
	type AuroraHttpContext,
	type AuroraResponse,
	type AuroraRouteConfig,
	auroraRoute,
} from "./route.js";
export {
	type RenderHttpContext,
	type RenderPageOptions,
	type RenderResponse,
	renderPage,
} from "./server/renderPage.js";
export {
	type AssetsHttpContext,
	type AssetsRequest,
	type AssetsResponse,
	type ServeAssetsOptions,
	serveAssets,
} from "./server/serveAssets.js";
export { renderToString } from "./ssr.js";
export type { TemplateResult } from "./types.js";
