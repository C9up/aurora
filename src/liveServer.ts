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

/**
 * Per-request guard. Return `false` to reject the event with 403.
 *
 * Required, and that is the point. It used to be optional and its absence meant
 * "allowed", so the endpoint that drives every live session shipped open unless
 * someone thought to close it — and the showcase app itself did not. A session
 * id is a `randomUUID`, so an attacker needs it to do anything, but an
 * unguessable identifier is a secret, and a secret is not an authorisation
 * check: it leaks through a referrer, a log line, a shared screenshot.
 *
 * Required rather than defaulted to deny, so the omission is a type error at
 * build rather than a 403 discovered in production. Enforce the same
 * auth / CSRF / ownership policy as the page that mounted the session; return
 * `true` deliberately if the route is already guarded by host middleware.
 */
export type AuthorizeLiveEvent = (
	ctx: LiveHttpContext,
	body: LiveEventBody,
) => boolean | Promise<boolean>;

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
 * `authorize` is required — see {@link AuthorizeLiveEvent}.
 */
export function wireLiveEvents(
	router: LiveHttpRouter,
	live: LiveRouter,
	authorize: AuthorizeLiveEvent,
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
		let authorized = false;
		try {
			authorized = await authorize(ctx, body);
		} catch {
			// A guard that throws is a guard that did not say yes.
			authorized = false;
		}
		if (!authorized) {
			ctx.response.status(403);
			ctx.response.json({ error: "forbidden live event" });
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
