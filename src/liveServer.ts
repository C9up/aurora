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

import type { LiveRouter } from "./liveRouter.js";

/** The slice of the host HTTP router this needs. */
export interface LiveHttpRouter {
	post(path: string, handler: (ctx: LiveHttpContext) => unknown): unknown;
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

interface LiveEventBody {
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
export const DEFAULT_LIVE_EVENT_PATH = "/_live/event";

/**
 * Register the inbound live-event route on the host router. Call once at boot
 * (e.g. from a provider that resolved the router + relay from the container).
 */
export function wireLiveEvents(
	router: LiveHttpRouter,
	live: LiveRouter,
	options: WireLiveEventsOptions = {},
): void {
	const path = options.path ?? DEFAULT_LIVE_EVENT_PATH;
	router.post(path, (ctx) => {
		const body = ctx.request.body();
		if (!isLiveEventBody(body)) {
			ctx.response.status(400);
			ctx.response.json({ error: "live event requires { id, event }" });
			return;
		}
		const handled = live.event(body.id, body.event, body.payload);
		if (!handled) {
			ctx.response.status(404);
			ctx.response.json({ error: "unknown live session" });
			return;
		}
		ctx.response.json({ ok: true });
	});
}
