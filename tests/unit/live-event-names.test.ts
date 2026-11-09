/**
 * Only a live component's OWN handler functions can be dispatched. An event
 * name used to be looked up through the prototype chain, so a client could
 * call `constructor`, `toString` or `__defineGetter__` and make the route throw.
 */
import { describe, expect, it } from "vitest";
import {
	createLiveRegistry,
	createLiveRouter,
	html,
	type LiveHttpContext,
	mountLiveSession,
	signal,
	wireLiveEvents,
} from "../../src/index.js";

const PROTOTYPE_NAMES = [
	"constructor",
	"toString",
	"valueOf",
	"hasOwnProperty",
	"isPrototypeOf",
	"__defineGetter__",
	"__lookupGetter__",
	"__proto__",
];

function setup(handlers: Record<string, (payload?: unknown) => void>) {
	const registry = createLiveRegistry();
	registry.define("Thing", () => ({
		view: html`<b>${signal("x")}</b>`,
		handlers,
	}));
	const live = createLiveRouter(registry, { broadcast: () => 1 });
	let route: ((ctx: LiveHttpContext) => void | Promise<void>) | undefined;
	wireLiveEvents(
		{
			post(_path, handler) {
				route = handler;
			},
		},
		live,
		() => "alice",
	);
	const mount = live.mount("Thing", "alice");
	const post = async (event: string, payload: unknown = "x") => {
		const reply = { status: 200, body: undefined as unknown };
		const ctx: LiveHttpContext = {
			request: { body: () => ({ id: mount.id, event, payload }) },
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
		await route?.(ctx);
		return reply;
	};
	return { live, mount, post };
}

describe("aurora > live > event names", () => {
	it("answers 400 to every prototype name, and calls nothing", async () => {
		let calls = 0;
		const { post } = setup({ ping: () => calls++ });
		for (const name of PROTOTYPE_NAMES) {
			const reply = await post(name);
			expect(reply, name).toEqual({
				status: 400,
				body: { error: "unknown live event" },
			});
		}
		expect(calls).toBe(0);
	});

	it("dispatches an own handler", async () => {
		const received: unknown[] = [];
		const { post } = setup({ ping: (payload) => received.push(payload) });
		expect(await post("ping", { n: 1 })).toEqual({
			status: 200,
			body: { ok: true },
		});
		expect(received).toEqual([{ n: 1 }]);
	});

	it("does not reach a class instance's inherited methods", () => {
		class Handlers {
			ping(): void {}
			secret(): void {
				throw new Error("inherited method ran");
			}
		}
		const session = mountLiveSession(() => ({
			view: html`<b>x</b>`,
			handlers: { own: () => {} },
		}));
		expect(session.dispatch("own")).toBe(true);
		// What a class instance passed as `handlers` looks like: its methods live
		// on the prototype.
		const handlers: Record<string, (payload?: unknown) => void> = {};
		Object.setPrototypeOf(handlers, Handlers.prototype);
		expect(typeof Reflect.get(handlers, "secret")).toBe("function");
		const fromClass = mountLiveSession(() => ({
			view: html`<b>x</b>`,
			handlers,
		}));
		expect(fromClass.dispatch("secret")).toBe(false);
		expect(fromClass.dispatch("ping")).toBe(false);
	});

	it("ignores an own property that is not a function", () => {
		const handlers: Record<string, (payload?: unknown) => void> = {};
		Reflect.set(handlers, "data", 42);
		const session = mountLiveSession(() => ({
			view: html`<b>x</b>`,
			handlers,
		}));
		expect(session.dispatch("data")).toBe(false);
	});

	it("reports an unknown event through the router", () => {
		const { live, mount } = setup({ ping: () => {} });
		expect(live.event(mount.id, "nope", undefined, "alice")).toBe(
			"unknown-event",
		);
		expect(live.event(mount.id, "ping", undefined, "alice")).toBe("handled");
	});

	it("answers a throwing handler with a controlled 500, without the stack", async () => {
		const { post } = setup({
			boom: () => {
				throw new Error("db password is hunter2");
			},
		});
		const reply = await post("boom");
		expect(reply).toEqual({
			status: 500,
			body: { error: "live event failed" },
		});
	});
});
