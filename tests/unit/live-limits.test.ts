/**
 * A mounted live session costs memory until something disposes it, and a page
 * load mounts one before any stream exists. Sessions nobody claims expire, an
 * owner holds a bounded number, and the registry holds a bounded total.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLiveRegistry,
	createLiveRouter,
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

	it("keeps a claimed session by default: a watching client sends nothing", () => {
		const { registry, live } = setup({ claimTimeoutMs: 1_000 });
		const mount = live.mount("Counter", "alice");
		live.authorizeChannel(mount.id, "alice");
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);
		expect(registry.size()).toBe(1);
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

	it("refuses a mount past maxSessions, without building the component", () => {
		const { registry, live, built } = setup({ maxSessions: 2 });
		live.mount("Counter", "a");
		live.mount("Counter", "b");
		expect(built()).toBe(2);
		expect(codeOf(() => live.mount("Counter", "c"))).toBe(
			"E_AURORA_LIVE_SESSION_LIMIT",
		);
		expect(built()).toBe(2);
		expect(registry.size()).toBe(2);
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
			expect(() => createLiveRegistry(options)).toThrow(RangeError);
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
