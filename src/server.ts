// ─── Server-only surface (imports node:fs / node:path / node:url) ─────
//
// Kept OUT of the package's main barrel (`@c9up/aurora`) so a browser bundle
// importing client primitives (component/html/hydrate/render) never pulls the
// Node built-ins through the import graph. Server code imports from
// `@c9up/aurora/server`; the client `.` entry stays node-free.

export { AuroraManager, type AuroraManagerConfig } from "./AuroraManager.js";
export {
	type AuroraRequestRenderer,
	auroraContext,
} from "./middleware.js";
export { type PageFactory, Pages, type PagesConfig } from "./Pages.js";
export {
	type RenderHttpContext,
	type RenderPageOptions,
	type RenderResponse,
	renderPage,
	type SharedProps,
	type SharedPropsResolver,
} from "./server/renderPage.js";
export {
	type AssetsHttpContext,
	type AssetsRequest,
	type AssetsResponse,
	packageAssetDir,
	type ServeAssetsOptions,
	serveAssets,
} from "./server/serveAssets.js";
