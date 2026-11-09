/**
 * Live server wiring (Stage 6) — register the inbound-event HTTP route that
 * feeds the {@link LiveRouter}. The client POSTs `{ id, event, payload }` here;
 * the route dispatches it to the session, whose patches broadcast over relay.
 *
 * Agnostic: the host HTTP router + context are DUCK-TYPED (a `post(path,
 * handler)` router; a `ctx.request.body()` / `ctx.response` context) — no
 * `@c9up/ream` import. Mirrors how warden/blackhole middleware read the ctx.
 * Mount (render + ids) is done by the page handler via `liveRouter.mount`;
 * disconnect is wired by the app: relay's disconnect → `liveRouter.disconnect`.
 */

import type {
	IdentifyLiveCaller,
	LiveEventOutcome,
	LiveRouter,
} from "./liveRouter.js";

/** The slice of the host HTTP router this needs. */
export interface LiveHttpRouter {
	/**
	 * The handler returns `void | Promise<void>`, not `unknown`: that is what an
	 * HTTP handler returns in ream and in AdonisJS, and the wider shape made
	 * ream's own Router fail to satisfy this interface.
	 */
	post(
		path: string,
		handler: (ctx: LiveHttpContext) => void | Promise<void>,
	): unknown;
}

/** The slice of the host HTTP context this needs (Ream's HttpContext satisfies it). */
export interface LiveHttpContext {
	request: { body(): unknown };
	response: {
		status(code: number): unknown;
		json(data: unknown): void;
	};
}

export interface WireLiveEventsOptions {
	/** Route path for inbound events (must match the client transport). */
	path?: string;
}

export interface LiveEventBody {
	id: string;
	event: string;
	payload?: unknown;
}

/** Structural guard for the POST body — no casts (`in`-narrowing + typeof). */
function isLiveEventBody(value: unknown): value is LiveEventBody {
	if (typeof value !== "object" || value === null) return false;
	if (!("id" in value) || !("event" in value)) return false;
	return typeof value.id === "string" && typeof value.event === "string";
}

/** Default inbound-event route — keep the client transport's `path` in sync. */
export const DEFAULT_LIVE_EVENT_PATH = "/__live/event";

/**
 * Register the inbound live-event route on the host router. Call once at boot
 * (e.g. from a provider that resolved the router + relay from the container).
 *
 * `identify` is required, and it is what makes the route safe: it returns the
 * principal behind the request — the user id, the session id — and the event
 * only reaches a session mounted for that same owner. Anything else is a 403,
 * without the app writing the check. A session id alone used to be enough to
 * drive anyone's session, and an unguessable id is a secret, not an
 * authorisation check: it leaks through a referrer, a log line, a screenshot.
 */
export function wireLiveEvents(
	router: LiveHttpRouter,
	live: LiveRouter,
	identify: IdentifyLiveCaller<LiveHttpContext>,
	options: WireLiveEventsOptions = {},
): void {
	const path = options.path ?? DEFAULT_LIVE_EVENT_PATH;
	router.post(path, async (ctx) => {
		const body = ctx.request.body();
		if (!isLiveEventBody(body)) {
			ctx.response.status(400);
			ctx.response.json({ error: "live event requires { id, event }" });
			return;
		}
		let callerId: string | undefined;
		try {
			callerId = await identify(ctx);
		} catch {
			// Not knowing who asks is not permission.
			callerId = undefined;
		}
		let outcome: LiveEventOutcome;
		try {
			outcome =
				callerId === undefined || callerId === ""
					? "forbidden"
					: live.event(body.id, body.event, body.payload, callerId);
		} catch {
			// A handler that throws is the component's bug, not the client's — and
			// what it threw stays on the server.
			ctx.response.status(500);
			ctx.response.json({ error: "live event failed" });
			return;
		}
		if (outcome === "forbidden") {
			ctx.response.status(403);
			ctx.response.json({ error: "forbidden live event" });
			return;
		}
		if (outcome === "unknown-session") {
			ctx.response.status(404);
			ctx.response.json({ error: "unknown live session" });
			return;
		}
		if (outcome === "unknown-event") {
			ctx.response.status(400);
			ctx.response.json({ error: "unknown live event" });
			return;
		}
		ctx.response.json({ ok: true });
	});
}
