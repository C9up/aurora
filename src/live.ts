/**
 * `@c9up/aurora/live` barrel — the whole Live surface behind ONE subpath.
 *
 * The transport-agnostic core (`mountLiveSession` + its types) lives in
 * `./liveSession.js`; the transport stack (broadcast / client / registry /
 * router / server) builds on it. Re-exporting everything here keeps the niche
 * surface behind a single subpath and keeps the main `.` barrel lean (it no
 * longer eager-pulls these into every browser graph), consistent with how
 * `./ssr`, `./relay`, `./rpc` and `./hydrate` are already subpath-gated.
 *
 * The core lives in a SEPARATE module (not inline here) so the transport files
 * import it directly from `./liveSession.js` rather than through this barrel —
 * which would otherwise form an import cycle (barrel → transport → barrel).
 */

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
	type LiveEventBody,
	type LiveHttpContext,
	type LiveHttpRouter,
	type WireLiveEventsOptions,
	wireLiveEvents,
} from "./liveServer.js";
export {
	type LiveComponentDefinition,
	type LiveSession,
	mountLiveSession,
	type SlotPatch,
} from "./liveSession.js";
