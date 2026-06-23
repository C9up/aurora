// ─── Client surface (node-free — safe to bundle for the browser) ──────
//
// Server-only exports (AuroraManager, Pages, renderPage, serveAssets) that pull
// node:fs / node:path / node:url live in `@c9up/aurora/server`. Keeping them off
// this barrel is what lets a browser bundle import the client primitives without
// the bundler dragging Node built-ins through the import graph.
export type {
	CookieOptions,
	PersistedSignalOptions,
	ShareData,
	StorageArea,
	WebStorageOptions,
	WindowSize,
} from "./browser.js";
export {
	back,
	clipboard,
	cookie,
	forward,
	hash,
	mediaQuery,
	navigate,
	online,
	persistedSignal,
	prefersDark,
	queryParam,
	redirect,
	reload,
	replace,
	session,
	share,
	storage,
	visibility,
	WebStorage,
	windowSize,
} from "./browser.js";
export type { Command } from "./command.js";
export { command } from "./command.js";
export { component, onMount, onUnmount } from "./component.js";
export type {
	FieldErrors,
	Form,
	FormField,
	FormOptions,
	FormSchema,
	FormValidate,
} from "./form.js";
export { form } from "./form.js";
export { html, isTemplateResult } from "./html.js";
export type {
	HttpClientOptions,
	HttpRequestOptions,
	HttpResult,
} from "./http.js";
export {
	HttpClient,
	HttpError,
	http,
	isAbortError,
	isHttpError,
} from "./http.js";
export { hydrate } from "./hydrate.js";
export {
	type LiveComponentDefinition,
	type LiveSession,
	mountLiveSession,
	type SlotPatch,
} from "./live.js";
export {
	connectPatches,
	type LiveStore,
	liveStore,
	type RelayBroadcaster,
} from "./liveBroadcast.js";
export {
	buildLiveTransport,
	type LiveClientOptions,
	type LiveClientTransport,
	type LiveHttpPoster,
	liveClient,
	type RelaySubscribeClient,
} from "./liveClient.js";
export {
	createLiveRegistry,
	type LiveRegistry,
	type LiveSessionHandle,
} from "./liveRegistry.js";
export {
	createLiveRouter,
	type LiveMount,
	type LiveRouter,
} from "./liveRouter.js";
export {
	DEFAULT_LIVE_EVENT_PATH,
	type LiveHttpContext,
	type LiveHttpRouter,
	type WireLiveEventsOptions,
	wireLiveEvents,
} from "./liveServer.js";
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
	createRpcClient,
	isRpcError,
	type RpcCall,
	type RpcClient,
	type RpcClientOptions,
	RpcError,
	type RpcResult,
} from "./rpc.js";
export { renderToString } from "./ssr.js";
export type { TemplateResult } from "./types.js";
