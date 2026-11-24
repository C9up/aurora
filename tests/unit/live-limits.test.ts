/**
 * A mounted live session costs memory until something disposes it, and a page
 * load mounts one before any stream exists. Sessions nobody claims expire, an
 * owner holds a bounded number, and the registry holds a bounded total.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLiveRegistry,
	createLiveRouter,
	errors,
	html,
	type LiveRegistryOptions,
	type RelayBroadcaster,
	signal,
} from "../../src/index.js";

const relay: RelayBroadcaster = { broadcast: () => 1 };

function setup(options?: LiveRegistryOptions) {
	const registry = createLiveRegistry(options);
	let built = 0;
	registry.define("Counter", () => {
		built++;
		const count = signal(0);
		return {
			view: html`<b><span>${count}</span></b>`,
			handlers: { inc: () => count(count() + 1) },
		};
	});
	return {
		registry,
		live: createLiveRouter(registry, relay),
		built: () => built,
	};
}

function codeOf(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return Reflect.get(Object(error), "code");
	}
	return undefined;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("aurora > live > unclaimed sessions", () => {
	it("disposes a session nobody claims within the claim timeout", () => {
		const { registry, live } = setup({ claimTimeoutMs: 10_000 });
		const mount = live.mount("Counter", "anon-1");
		vi.advanceTimersByTime(9_000);
		expect(registry.size()).toBe(1);
		vi.advanceTimersByTime(10_000);
		expect(registry.size()).toBe(0);
		expect(registry.get(mount.id)).toBeUndefined();
	});

	it("keeps a session claimed by its channel subscription", () => {
		const { registry, live } = setup({ claimTimeoutMs: 10_000 });
		const mount = live.mount("Counter", "alice");
		vi.advanceTimersByTime(5_000);
		expect(live.authorizeChannel(mount.id, "alice")).toBe(true);
		vi.advanceTimersByTime(60_000);
		expect(registry.size()).toBe(1);
	});

	it("keeps a session claimed by an event", () => {
		const { registry, live } = setup({ claimTimeoutMs: 10_000 });
		const mount = live.mount("Counter", "alice");
		expect(live.event(mount.id, "inc", undefined, "alice")).toBe("handled");
		vi.advanceTimersByTime(60_000);
		expect(registry.size()).toBe(1);
	});

	it("does not let a refused caller claim a session", () => {
		const { registry, live } = setup({ claimTimeoutMs: 10_000 });
		const mount = live.mount("Counter", "alice");
		expect(live.authorizeChannel(mount.id, "bob")).toBe(false);
		expect(live.event(mount.id, "inc", undefined, "bob")).toBe("forbidden");
		vi.advanceTimersByTime(30_000);
		expect(registry.size()).toBe(0);
	});

	it("frees the session's listeners when it expires", () => {
		const { registry, live } = setup({ claimTimeoutMs: 1_000 });
		const mount = live.mount("Counter", "anon");
		const session = registry.get(mount.id);
		const patches: unknown[] = [];
		session?.onPatch((patch) => patches.push(patch));
		vi.advanceTimersByTime(5_000);
		expect(registry.size()).toBe(0);
		session?.dispatch("inc");
		expect(patches).toEqual([]);
	});

	it("bounds the heap of page loads that never open the stream", () => {
		const { registry, live } = setup({ claimTimeoutMs: 1_000 });
		for (let i = 0; i < 2_000; i++) live.mount("Counter", `anon-${i}`);
		expect(registry.size()).toBe(2_000);
		vi.advanceTimersByTime(3_000);
		expect(registry.size()).toBe(0);
	});
});

describe("aurora > live > idle sessions", () => {
	it("disposes a claimed session idle past idleTimeoutMs", () => {
		const { registry, live } = setup({
			claimTimeoutMs: 1_000,
			idleTimeoutMs: 20_000,
		});
		const mount = live.mount("Counter", "alice");
		live.event(mount.id, "inc", undefined, "alice");
		vi.advanceTimersByTime(15_000);
		live.event(mount.id, "inc", undefined, "alice");
		vi.advanceTimersByTime(15_000);
		expect(registry.size()).toBe(1);
		vi.advanceTimersByTime(30_000);
		expect(registry.size()).toBe(0);
	});

	it("disposes a claimed session after ten silent minutes by default", () => {
		const { registry, live } = setup();
		const mount = live.mount("Counter", "alice");
		live.authorizeChannel(mount.id, "alice");
		vi.advanceTimersByTime(9 * 60_000);
		expect(registry.size()).toBe(1);
		vi.advanceTimersByTime(4 * 60_000);
		expect(registry.size()).toBe(0);
	});

	it("keeps a watching client's session while its keep-alives come", () => {
		const { registry, live } = setup();
		const mount = live.mount("Counter", "alice");
		live.authorizeChannel(mount.id, "alice");
		for (let minute = 0; minute < 60; minute += 2) {
			vi.advanceTimersByTime(2 * 60_000);
			expect(live.keepAlive(mount.id, "alice")).toBe("handled");
		}
		expect(registry.size()).toBe(1);
	});

	it("takes a keep-alive from the owner only, and claims nothing with it", () => {
		const { registry, live } = setup({ claimTimeoutMs: 10_000 });
		const mount = live.mount("Counter", "alice");
		expect(live.keepAlive(mount.id, "mallory")).toBe("forbidden");
		expect(live.keepAlive("no-such-id", "alice")).toBe("unknown-session");
		// Unclaimed: the keep-alive answers, and the claim timeout still runs.
		expect(live.keepAlive(mount.id, "alice")).toBe("handled");
		expect(registry.touch(mount.id)).toBe(false);
		vi.advanceTimersByTime(20_000);
		expect(registry.size()).toBe(0);
	});

	it("is not claimed by an event the component does not handle", () => {
		const { registry, live } = setup({ claimTimeoutMs: 10_000 });
		const mount = live.mount("Counter", "alice");
		expect(live.event(mount.id, "no-such-event", undefined, "alice")).toBe(
			"unknown-event",
		);
		vi.advanceTimersByTime(20_000);
		expect(registry.size()).toBe(0);
	});
});

describe("aurora > live > caps", () => {
	it("evicts an owner's oldest session past maxPerOwner", () => {
		const { registry, live } = setup({ maxPerOwner: 3 });
		const first = live.mount("Counter", "alice");
		live.mount("Counter", "alice");
		live.mount("Counter", "alice");
		const bob = live.mount("Counter", "bob");
		const fourth = live.mount("Counter", "alice");
		expect(registry.size()).toBe(4);
		expect(registry.get(first.id)).toBeUndefined();
		expect(registry.get(fourth.id)).toBeDefined();
		expect(registry.get(bob.id)).toBeDefined();
	});

	it("bounds the sessions one owner can pile up", () => {
		const { registry, live } = setup({ maxPerOwner: 5 });
		for (let i = 0; i < 1_000; i++) live.mount("Counter", "one-owner");
		expect(registry.size()).toBe(5);
	});

	it("refuses a mount past maxSessions when every session is in use, without building the component", () => {
		const { registry, live, built } = setup({ maxSessions: 2 });
		const a = live.mount("Counter", "a");
		const b = live.mount("Counter", "b");
		live.event(a.id, "inc", undefined, "a");
		live.event(b.id, "inc", undefined, "b");
		expect(built()).toBe(2);
		expect(codeOf(() => live.mount("Counter", "c"))).toBe(
			"E_AURORA_LIVE_SESSION_LIMIT",
		);
		expect(built()).toBe(2);
		expect(registry.size()).toBe(2);
	});

	it("makes room in a full registry with the oldest session nobody claimed", () => {
		const { registry, live } = setup({ maxSessions: 3 });
		const claimed = live.mount("Counter", "a");
		live.event(claimed.id, "inc", undefined, "a");
		const oldest = live.mount("Counter", "b");
		const newer = live.mount("Counter", "c");
		const next = live.mount("Counter", "d");
		expect(registry.size()).toBe(3);
		expect(registry.get(oldest.id)).toBeUndefined();
		expect(registry.get(newer.id)).toBeDefined();
		expect(registry.get(claimed.id)).toBeDefined();
		expect(registry.get(next.id)).toBeDefined();
	});

	it("then with the least recently used session silent for half the idle timeout", () => {
		const { registry, live } = setup({
			maxSessions: 2,
			idleTimeoutMs: 10 * 60_000,
		});
		const a = live.mount("Counter", "a");
		const b = live.mount("Counter", "b");
		live.event(a.id, "inc", undefined, "a");
		live.event(b.id, "inc", undefined, "b");
		vi.advanceTimersByTime(4 * 60_000);
		// `a` acts again: `b` is now the least recently used.
		live.event(a.id, "inc", undefined, "a");
		expect(codeOf(() => live.mount("Counter", "c"))).toBe(
			"E_AURORA_LIVE_SESSION_LIMIT",
		);
		vi.advanceTimersByTime(60_000);
		const c = live.mount("Counter", "c");
		expect(registry.get(b.id)).toBeUndefined();
		expect(registry.get(a.id)).toBeDefined();
		expect(registry.get(c.id)).toBeDefined();
	});

	it("lets an owner at its own cap replace a session when the registry is full", () => {
		const { registry, live } = setup({ maxSessions: 2, maxPerOwner: 1 });
		const a1 = live.mount("Counter", "a");
		live.mount("Counter", "b");
		const a2 = live.mount("Counter", "a");
		expect(registry.size()).toBe(2);
		expect(registry.get(a1.id)).toBeUndefined();
		expect(registry.get(a2.id)).toBeDefined();
	});

	it("rejects a limit that is not a positive number", () => {
		for (const options of [
			{ maxSessions: 0 },
			{ maxPerOwner: -1 },
			{ claimTimeoutMs: Number.NaN },
			{ idleTimeoutMs: 0 },
		]) {
			expect(() => createLiveRegistry(options)).toThrow(
				errors.E_AURORA_INVALID_LIVE_LIMIT,
			);
			expect(() => createLiveRegistry(options)).toThrow(
				expect.objectContaining({ code: "E_AURORA_INVALID_LIVE_LIMIT" }),
			);
		}
	});
});

describe("aurora > live > the sweep timer", () => {
	it("runs only while there are sessions", () => {
		const { registry, live } = setup({ claimTimeoutMs: 1_000 });
		expect(vi.getTimerCount()).toBe(0);
		live.mount("Counter", "anon");
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(5_000);
		expect(registry.size()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops when the last session is disposed by hand", () => {
		const { registry, live } = setup();
		const mount = live.mount("Counter", "alice");
		registry.dispose(mount.id);
		expect(vi.getTimerCount()).toBe(0);
		live.mount("Counter", "alice");
		registry.disposeAll();
		expect(vi.getTimerCount()).toBe(0);
	});
});
