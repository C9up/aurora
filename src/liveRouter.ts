/**
 * Live router (Stage 4) — the server-side orchestration that ties the session
 * registry to the relay transport, transport-agnostically.
 *
 *   - `mount(name, ownerId)` → mounts a session, wires its patches to a
 *     per-session channel, returns `{ id, channel, html }` for the HTTP
 *     response (the client renders `html` and subscribes to `channel`).
 *   - `event(id, event, payload, callerId)` → routes an inbound client event
 *     (a relay POST) to the session, if the caller owns it; its patches
 *     auto-broadcast on the channel.
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

/**
 * What became of an inbound event. `forbidden` when the caller is not the
 * principal the session was mounted for.
 */
export type LiveEventOutcome = "handled" | "unknown-session" | "forbidden";

export interface LiveRouter {
	/**
	 * Mount a session owned by `ownerId` — the principal that may drive it and
	 * subscribe to it, such as the user id or the session id the host's auth
	 * layer resolves. Wire its channel, return the initial render + ids.
	 */
	mount(name: string, ownerId: string): LiveMount;
	/**
	 * Route a client event to its session — only when `callerId`, the principal
	 * the host identified for this request, is the session's owner.
	 */
	event(
		id: string,
		event: string,
		payload: unknown,
		callerId: string,
	): LiveEventOutcome;
	/**
	 * May `callerId` subscribe to the session's channel? Only its owner may. The
	 * relay channel authorizer for `live/:id` — see {@link authorizeLiveChannel}.
	 */
	authorizeChannel(id: string, callerId: string): boolean;
	/** The owner a session was mounted for, or undefined for an unknown id. */
	ownerOf(id: string): string | undefined;
	/** Tear down every session an owner opened (call on relay disconnect). */
	disconnect(ownerId: string): void;
	/** The relay channel a session id broadcasts on. */
	channelFor(id: string): string;
}

/**
 * Create the live router over a session registry + a relay broadcaster. One per
 * app. The per-session channel is `live/<id>`; gate its subscription with
 * `relay.authorize("live/:id", authorizeLiveChannel(live, identify))`.
 */
export function createLiveRouter(
	registry: LiveRegistry,
	relay: RelayBroadcaster,
): LiveRouter {
	const channelFor = (id: string): string => `live/${id}`;
	// An empty caller is nobody: a host that resolved no principal must not
	// match a session mounted under an empty owner.
	const owns = (id: string, callerId: string): boolean =>
		callerId !== "" && registry.ownerOf(id) === callerId;

	return {
		mount(name, ownerId) {
			const { id, session } = registry.mount(name, ownerId);
			const channel = channelFor(id);
			// Patches flow to the channel; `disconnect` → registry disposes the
			// session, which clears its patch listener (stops broadcasting).
			connectPatches(session, relay, channel);
			return { id, channel, html: session.renderToString() };
		},
		event(id, event, payload, callerId) {
			const session = registry.get(id);
			if (!session) return "unknown-session";
			if (!owns(id, callerId)) return "forbidden";
			session.dispatch(event, payload);
			return "handled";
		},
		authorizeChannel(id, callerId) {
			return owns(id, callerId);
		},
		ownerOf: (id) => registry.ownerOf(id),
		disconnect(ownerId) {
			registry.disposeOwner(ownerId);
		},
		channelFor,
	};
}

/**
 * Resolve the principal behind a request — the user id, the session id —
 * or undefined when there is none. The same one `mount` was given as owner.
 */
export type IdentifyLiveCaller<C> = (
	ctx: C,
) => string | undefined | Promise<string | undefined>;

/**
 * A relay channel authorizer for `live/:id`: lets only the session's owner
 * subscribe to its patches.
 *
 * ```ts
 * relay.authorize<{ id: string }>("live/:id", authorizeLiveChannel(live, (ctx) => ctx.auth?.user?.id))
 * ```
 */
export function authorizeLiveChannel<C>(
	live: LiveRouter,
	identify: IdentifyLiveCaller<C>,
): (ctx: C, params: { id: string }) => Promise<boolean> {
	return async (ctx, params) => {
		let callerId: string | undefined;
		try {
			callerId = await identify(ctx);
		} catch {
			// Not knowing who asks is not permission.
			return false;
		}
		return callerId !== undefined && live.authorizeChannel(params.id, callerId);
	};
}
