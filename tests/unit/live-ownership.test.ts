/**
 * A live session belongs to the principal that mounted it. Holding its id is
 * not enough to drive it or to subscribe to its channel: the id is a secret,
 * and a secret is not an authorisation check.
 */
import { describe, expect, it } from "vitest";
import {
	authorizeLiveChannel,
	createLiveRegistry,
	createLiveRouter,
	html,
	type LiveHttpContext,
	type LiveHttpRouter,
	type RelayBroadcaster,
	signal,
	wireLiveEvents,
} from "../../src/index.js";

function setup() {
	const sent: Array<{ channel: string; data: unknown }> = [];
	const relay: RelayBroadcaster = {
		broadcast(channel, data) {
			sent.push({ channel, data });
			return 1;
		},
	};
	const registry = createLiveRegistry();
	registry.define("Secret", () => {
		const count = signal(0);
		return {
			view: html`<b><span>${count}</span></b>`,
			handlers: { reset: () => count(count() + 1) },
		};
	});
	return { registry, live: createLiveRouter(registry, relay), sent };
}

interface Reply {
	status: number;
	body: unknown;
}

/** A request from `user`, as the host's auth layer would have identified it. */
function request(body: unknown, user: string | undefined) {
	const reply: Reply = { status: 200, body: undefined };
	const ctx: LiveHttpContext & { user: string | undefined } = {
		user,
		request: { body: () => body },
		response: {
			status(code) {
				reply.status = code;
				return ctx.response;
			},
			json(data) {
				reply.body = data;
			},
		},
	};
	return { ctx, reply };
}

function route(live: ReturnType<typeof createLiveRouter>) {
	let handler: ((ctx: LiveHttpContext) => void | Promise<void>) | undefined;
	const router: LiveHttpRouter = {
		post(_path, h) {
			handler = h;
		},
	};
	wireLiveEvents(router, live, (ctx) => Reflect.get(ctx, "user"));
	return async (body: unknown, user: string | undefined): Promise<Reply> => {
		const { ctx, reply } = request(body, user);
		await handler?.(ctx);
		return reply;
	};
}

describe("aurora > live > ownership", () => {
	it("tells who owns a session", () => {
		const { registry, live } = setup();
		const mount = live.mount("Secret", "alice");
		expect(registry.ownerOf(mount.id)).toBe("alice");
		expect(live.ownerOf(mount.id)).toBe("alice");
		expect(live.ownerOf("ghost")).toBeUndefined();
	});

	it("refuses an event from anyone but the owner", () => {
		const { live, sent } = setup();
		const mount = live.mount("Secret", "alice");
		expect(live.event(mount.id, "reset", undefined, "bob")).toBe("forbidden");
		expect(sent).toEqual([]);
		expect(live.event(mount.id, "reset", undefined, "alice")).toBe("handled");
		expect(sent).toHaveLength(1);
		expect(live.event("ghost", "reset", undefined, "alice")).toBe(
			"unknown-session",
		);
	});

	it("answers 403 to bob posting on alice's session, and broadcasts nothing", async () => {
		const { live, sent } = setup();
		const post = route(live);
		const mount = live.mount("Secret", "alice");
		const reply = await post({ id: mount.id, event: "reset" }, "bob");
		expect(reply.status).toBe(403);
		expect(sent).toEqual([]);
	});

	it("lets alice drive her own session", async () => {
		const { live, sent } = setup();
		const post = route(live);
		const mount = live.mount("Secret", "alice");
		const reply = await post({ id: mount.id, event: "reset" }, "alice");
		expect(reply).toEqual({ status: 200, body: { ok: true } });
		expect(sent).toEqual([
			{ channel: mount.channel, data: [{ slot: 0, value: "1" }] },
		]);
	});

	it("answers 403 to a caller the host could not identify", async () => {
		const { live, sent } = setup();
		const post = route(live);
		const mount = live.mount("Secret", "alice");
		expect(
			(await post({ id: mount.id, event: "reset" }, undefined)).status,
		).toBe(403);
		expect((await post({ id: mount.id, event: "reset" }, "")).status).toBe(403);
		expect(sent).toEqual([]);
	});

	it("answers 403 when identifying the caller throws", async () => {
		const { live } = setup();
		let handler: ((ctx: LiveHttpContext) => void | Promise<void>) | undefined;
		wireLiveEvents(
			{
				post(_path, h) {
					handler = h;
				},
			},
			live,
			() => {
				throw new Error("session store down");
			},
		);
		const mount = live.mount("Secret", "alice");
		const { ctx, reply } = request({ id: mount.id, event: "reset" }, "alice");
		await handler?.(ctx);
		expect(reply.status).toBe(403);
	});

	it("answers 404 for an unknown session", async () => {
		const { live } = setup();
		const post = route(live);
		expect((await post({ id: "ghost", event: "reset" }, "alice")).status).toBe(
			404,
		);
	});

	it("authorizes the session channel for its owner only", async () => {
		const { live } = setup();
		const mount = live.mount("Secret", "alice");
		const authorize = authorizeLiveChannel(
			live,
			(ctx: { user?: string }) => ctx.user,
		);
		expect(await authorize({ user: "bob" }, { id: mount.id })).toBe(false);
		expect(await authorize({}, { id: mount.id })).toBe(false);
		expect(await authorize({ user: "alice" }, { id: "ghost" })).toBe(false);
		expect(await authorize({ user: "alice" }, { id: mount.id })).toBe(true);
	});

	it("refuses the channel when identifying the subscriber throws", async () => {
		const { live } = setup();
		const mount = live.mount("Secret", "alice");
		const authorize = authorizeLiveChannel(live, (): string => {
			throw new Error("down");
		});
		expect(await authorize({}, { id: mount.id })).toBe(false);
	});
});
