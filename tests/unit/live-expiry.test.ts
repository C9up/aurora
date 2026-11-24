/**
 * A claimed live session does not outlive its client on the default
 * configuration: claims come from handled events only, a claimed session ends
 * after ten silent minutes unless its client keeps it alive, and a full
 * registry makes room with sessions nobody is using.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildLiveTransport,
	createLiveRegistry,
	createLiveRouter,
	DEFAULT_LIVE_KEEP_ALIVE_MS,
	html,
	type LiveHttpContext,
	type LiveRegistry,
	type LiveRouter,
	liveClient,
	renderToString,
	signal,
	wireLiveEvents,
} from "../../src/index.js";

type Handler = (ctx: LiveHttpContext) => void | Promise<void>;

/** The documented wiring, `identify` reading the visitor's session id. */
function app(registry: LiveRegistry): {
	live: LiveRouter;
	post: (sid: string, body: unknown) => Promise<number>;
} {
	const live = createLiveRouter(registry, { broadcast: () => 0 });
	registry.define("Counter", () => {
		const count = signal(0);
		return {
			view: html`<button data-live-click="increment">Count: <span>${count}</span></button>`,
			handlers: { increment: () => count(count() + 1) },
		};
	});
	const routes = new Map<string, Handler>();
	const callers = new WeakMap<object, string>();
	wireLiveEvents(
		{ post: (path, handler) => routes.set(path, handler) },
		live,
		(ctx) => callers.get(ctx),
	);
	const post = async (sid: string, body: unknown): Promise<number> => {
		let status = 200;
		const ctx: LiveHttpContext = {
			request: { body: () => body },
			response: {
				status: (code) => {
					status = code;
				},
				json: () => {},
			},
		};
		callers.set(ctx, sid);
		await routes.get("/__live/event")?.(ctx);
		return status;
	};
	return { live, post };
}

function codeOf(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return Reflect.get(Object(error), "code");
	}
	return undefined;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("aurora > live > sessions end with their clients", () => {
	it("frees the slots visitors claimed once, and a later mount succeeds", async () => {
		const registry = createLiveRegistry({ maxSessions: 50 });
		const { live, post } = app(registry);
		for (let i = 0; i < 50; i++) {
			const sid = `visitor-${i}`;
			const { id } = live.mount("Counter", sid);
			const event = i % 2 === 0 ? "increment" : "no-such-event";
			expect(await post(sid, { id, event })).toBe(i % 2 === 0 ? 200 : 400);
		}
		expect(registry.size()).toBe(50);
		// A 400 claims nothing: those go with the claim timeout.
		await vi.advanceTimersByTimeAsync(76_000);
		expect(registry.size()).toBe(25);
		// The claimed ones go once their clients have been silent ten minutes.
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(registry.size()).toBe(0);
		expect(
			codeOf(() => live.mount("Counter", "an honest visitor")),
		).toBeUndefined();
	});

	it("makes room in a full registry once the claimed sessions fall silent", async () => {
		const registry = createLiveRegistry({ maxSessions: 50 });
		const { live, post } = app(registry);
		for (let i = 0; i < 50; i++) {
			const { id } = live.mount("Counter", `visitor-${i}`);
			await post(`visitor-${i}`, { id, event: "increment" });
		}
		expect(codeOf(() => live.mount("Counter", "an honest visitor"))).toBe(
			"E_AURORA_LIVE_SESSION_LIMIT",
		);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(
			codeOf(() => live.mount("Counter", "an honest visitor")),
		).toBeUndefined();
	});

	it("keeps a session alive through the event route, for its owner only", async () => {
		const registry = createLiveRegistry();
		const { live, post } = app(registry);
		const { id } = live.mount("Counter", "alice");
		expect(live.authorizeChannel(id, "alice")).toBe(true);
		expect(await post("mallory", { id, keepAlive: true })).toBe(403);
		expect(await post("alice", { id: "no-such-id", keepAlive: true })).toBe(
			404,
		);
		for (let minute = 0; minute < 30; minute += 2) {
			await vi.advanceTimersByTimeAsync(2 * 60_000);
			expect(await post("alice", { id, keepAlive: true })).toBe(200);
		}
		expect(registry.size()).toBe(1);
		await vi.advanceTimersByTimeAsync(11 * 60_000);
		expect(registry.size()).toBe(0);
	});
});

describe("aurora > live client > keep-alive", () => {
	it("sends one per interval while mounted, and none once disposed", () => {
		const count = signal(0);
		const view = () => html`<b><span>${count}</span></b>`;
		const container = document.createElement("div");
		container.innerHTML = renderToString(view());
		const kept: string[] = [];
		const dispose = liveClient({
			container,
			factory: view,
			mount: { id: "abc", channel: "live/abc" },
			transport: {
				subscribe: () => () => {},
				post: () => {},
				keepAlive: (id) => kept.push(id),
			},
		});
		vi.advanceTimersByTime(DEFAULT_LIVE_KEEP_ALIVE_MS * 3);
		expect(kept).toEqual(["abc", "abc", "abc"]);
		dispose();
		vi.advanceTimersByTime(DEFAULT_LIVE_KEEP_ALIVE_MS * 3);
		expect(kept).toHaveLength(3);
	});

	it("posts `{ id, keepAlive: true }` on the event route, and stays quiet when it fails", async () => {
		const sent: unknown[] = [];
		const transport = buildLiveTransport(
			{ subscribe: () => () => {} },
			{
				post: (url, body) => {
					sent.push({ url, body });
					return Promise.reject(new Error("offline"));
				},
			},
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		transport.keepAlive?.("abc");
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toEqual([
			{ url: "/__live/event", body: { id: "abc", keepAlive: true } },
		]);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
