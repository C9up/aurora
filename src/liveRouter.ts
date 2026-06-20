/**
 * Live router (Stage 4) — the server-side orchestration that ties the session
 * registry to the relay transport, transport-agnostically.
 *
 *   - `mount(name, ownerId)` → mounts a session, wires its patches to a
 *     per-session channel, returns `{ id, channel, html }` for the HTTP
 *     response (the client renders `html` and subscribes to `channel`).
 *   - `event(id, event, payload)` → routes an inbound client event (a relay
 *     POST) to the session; its patches auto-broadcast on the channel.
 *   - `disconnect(ownerId)` → disposes every session that owner opened.
 *
 * Pure orchestration over the duck-typed registry + relay — node-free, no
 * `@c9up/ream` / `@c9up/relay` import. The thin HTTP/relay wiring (register the
 * POST route, hook relay's disconnect) is the provider/app's job and feeds
 * these three methods.
 */

import { connectPatches, type RelayBroadcaster } from "./liveBroadcast.js";
import type { LiveRegistry } from "./liveRegistry.js";

/** What a client needs after mounting: render this `html`, subscribe to `channel`. */
export interface LiveMount {
	id: string;
	channel: string;
	html: string;
}

export interface LiveRouter {
	/** Mount a session, wire its channel, return the initial render + ids. */
	mount(name: string, ownerId: string): LiveMount;
	/** Route a client event to its session. Returns false if the id is unknown. */
	event(id: string, event: string, payload?: unknown): boolean;
	/** Tear down every session an owner opened (call on relay disconnect). */
	disconnect(ownerId: string): void;
	/** The relay channel a session id broadcasts on. */
	channelFor(id: string): string;
}

/**
 * Create the live router over a session registry + a relay broadcaster. One per
 * app. The per-session channel is `live/<id>`; gate subscription with
 * `relay.authorize("live/*", …)` if the components carry sensitive state.
 */
export function createLiveRouter(
	registry: LiveRegistry,
	relay: RelayBroadcaster,
): LiveRouter {
	const channelFor = (id: string): string => `live/${id}`;

	return {
		mount(name, ownerId) {
			const { id, session } = registry.mount(name, ownerId);
			const channel = channelFor(id);
			// Patches flow to the channel; `disconnect` → registry disposes the
			// session, which clears its patch listener (stops broadcasting).
			connectPatches(session, relay, channel);
			return { id, channel, html: session.renderToString() };
		},
		event(id, event, payload) {
			const session = registry.get(id);
			if (!session) return false;
			session.dispatch(event, payload);
			return true;
		},
		disconnect(ownerId) {
			registry.disposeOwner(ownerId);
		},
		channelFor,
	};
}
