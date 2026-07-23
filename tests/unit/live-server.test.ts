/**
 * Live wiring (Stage 6) — the server event route (`wireLiveEvents`) and the
 * client transport builder (`buildLiveTransport`), both duck-typed and tested
 * with fakes (no real HTTP server / relay / browser).
 */
import { describe, expect, it, vi } from "vitest";
import {
	buildLiveTransport,
	createLiveRegistry,
	createLiveRouter,
	html,
	type LiveHttpContext,
	type LiveHttpRouter,
	type RelayBroadcaster,
	signal,
	type SlotPatch,
	wireLiveEvents,
} from "../../src/index.js";

function fakeRelay() {
	const sent: Array<{ channel: string; data: unknown }> = [];
	return {
		sent,
		broadcast(channel: string, data: unknown): number {
			sent.push({ channel, data });
			return 1;
		},
	} satisfies RelayBroadcaster & {
		sent: Array<{ channel: string; data: unknown }>;
	};
}

/** A fake HTTP router that captures the registered POST handler. */
function fakeRouter() {
	const routes = new Map<string, (ctx: LiveHttpContext) => unknown>();
	return {
		routes,
		post(path: string, handler: (ctx: LiveHttpContext) => unknown) {
			routes.set(path, handler);
		},
	} satisfies LiveHttpRouter & {
		routes: Map<string, (ctx: LiveHttpContext) => unknown>;
	};
}

/** A fake ctx with a given body; records status + json. */
function fakeCtx(body: unknown) {
	const res = { status: 200, body: undefined as unknown };
	const ctx: LiveHttpContext = {
		request: { body: () => body },
		response: {
			status(code) {
				res.status = code;
				return ctx.response;
			},
			json(data) {
				res.body = data;
			},
		},
	};
	return { ctx, res };
}

function setup() {
	const reg = createLiveRegistry();
	reg.define("Counter", () => {
		const count = signal(0);
		return {
			view: html`<b><span>${count}</span></b>`,
			handlers: { increment: () => count(count() + 1) },
		};
	});
	const relay = fakeRelay();
	return { router: createLiveRouter(reg, relay), relay };
}

describe("aurora > wireLiveEvents", () => {
	it("dispatches a valid POST to the live router and broadcasts", async () => {
		const { router, relay } = setup();
		const http = fakeRouter();
		wireLiveEvents(http, router);

		const handler = http.routes.get("/__live/event");
		expect(handler).toBeDefined();

		const mount = router.mount("Counter", "alice");
		const { ctx, res } = fakeCtx({ id: mount.id, event: "increment" });
		await handler?.(ctx);

		expect(res.body).toEqual({ ok: true });
		expect(relay.sent).toEqual([
			{ channel: mount.channel, data: [{ slot: 0, value: "1" }] },
		]);
	});

	it("rejects a malformed body with 400", async () => {
		const { router } = setup();
		const http = fakeRouter();
		wireLiveEvents(http, router);
		const { ctx, res } = fakeCtx({ nope: true });
		await http.routes.get("/__live/event")?.(ctx);
		expect(res.status).toBe(400);
	});

	it("returns 404 for an unknown session id", async () => {
		const { router } = setup();
		const http = fakeRouter();
		wireLiveEvents(http, router, { path: "/live" });
		const { ctx, res } = fakeCtx({ id: "ghost", event: "increment" });
		await http.routes.get("/live")?.(ctx);
		expect(res.status).toBe(404);
	});

	it("rejects a valid live event when the integrated authorize hook denies it", async () => {
		const { router, relay } = setup();
		const http = fakeRouter();
		const authorize = vi.fn(() => false);
		wireLiveEvents(http, router, { authorize });
		const mount = router.mount("Counter", "alice");

		const { ctx, res } = fakeCtx({ id: mount.id, event: "increment" });
		await http.routes.get("/__live/event")?.(ctx);

		expect(authorize).toHaveBeenCalledWith(ctx, {
			id: mount.id,
			event: "increment",
		});
		expect(res.status).toBe(403);
		expect(res.body).toEqual({ error: "forbidden live event" });
		expect(relay.sent).toEqual([]);
	});
});

describe("aurora > buildLiveTransport", () => {
	it("wires subscribe → relay and post → http on the matching path", () => {
		const subs: Array<{ channel: string }> = [];
		const relayClient = {
			subscribe<E>(channel: string, _handler: (event: E) => void) {
				subs.push({ channel });
				return () => {};
			},
		};
		const http = { post: vi.fn() };
		const transport = buildLiveTransport(relayClient, http);

		transport.subscribe("live/abc", (_p: SlotPatch[]) => {});
		expect(subs).toEqual([{ channel: "live/abc" }]);

		transport.post("abc", "increment", { x: 1 });
		expect(http.post).toHaveBeenCalledWith("/__live/event", {
			id: "abc",
			event: "increment",
			payload: { x: 1 },
		});
	});
});
