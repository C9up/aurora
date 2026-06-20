/**
 * Live broadcast (Stage 3) — pipe live-component patches onto a relay channel,
 * and the SHARED-store primitive that makes live components multiplayer.
 *
 * aurora stays framework-agnostic: it DUCK-TYPES a {@link RelayBroadcaster}
 * (just `broadcast(channel, data)`) and never imports `@c9up/relay`. The app
 * passes its relay instance. Channel authorization (who may subscribe) is the
 * relay's job — configure it with `relay.authorize(channel, …)`; aurora only
 * pushes patches.
 *
 * Per-session use: `connectPatches(session, relay, "live/<id>")`.
 * Shared/multiplayer use: `liveStore(factory, relay, "room/<id>")` — ONE
 * server-side instance whose state is shared by every client on the channel;
 * one mutation → one patch computed once → relay fans it out to all subscribers
 * (O(1) compute, O(N) network).
 */

import {
	type LiveComponentDefinition,
	type LiveSession,
	mountLiveSession,
	type SlotPatch,
} from "./live.js";

/**
 * Minimal relay surface aurora needs. The real `@c9up/relay` `Relay` satisfies
 * it (`broadcast(channel, data) → recipient count`); aurora never imports it.
 */
export interface RelayBroadcaster {
	broadcast(channel: string, data: unknown): number;
}

/**
 * Pipe a session's patches onto a relay channel as they are produced. Returns
 * an unsubscribe. Each patch becomes one `broadcast(channel, patch)`.
 */
export function connectPatches(
	session: LiveSession,
	relay: RelayBroadcaster,
	channel: string,
): () => void {
	return session.onPatch((patch: SlotPatch[]) => {
		relay.broadcast(channel, patch);
	});
}

/**
 * A shared, broadcast-backed live store — the multiplayer primitive. One
 * server-side instance; every client on `channel` renders its initial HTML and
 * subscribes for patches. A `dispatch` mutates the shared signals ONCE; the
 * resulting patch is broadcast to the whole channel.
 */
export interface LiveStore {
	/** The relay channel this store broadcasts on. */
	readonly channel: string;
	/** Current shared-state HTML — served to each client that joins. */
	renderToString(): string;
	/** Run a handler that mutates the shared state → one broadcast patch. */
	dispatch(event: string, payload?: unknown): void;
	/** Stop broadcasting + free the underlying session. */
	dispose(): void;
}

/**
 * Create a shared live store. Signals declared inside `factory` are the SHARED
 * state (one instance, not per-client). Pair with `relay.authorize(channel, …)`
 * to gate who may subscribe.
 */
export function liveStore(
	factory: () => LiveComponentDefinition,
	relay: RelayBroadcaster,
	channel: string,
): LiveStore {
	const session = mountLiveSession(factory);
	const off = connectPatches(session, relay, channel);
	return {
		channel,
		renderToString: () => session.renderToString(),
		dispatch: (event, payload) => session.dispatch(event, payload),
		dispose: () => {
			off();
			session.dispose();
		},
	};
}
