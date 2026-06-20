/**
 * Live session registry (Stage 2) — definition registration, per-session mount
 * with independent state, lookup/dispatch, and ownership-scoped disposal
 * (the disconnect path).
 */
import { describe, expect, it } from "vitest";
import { createLiveRegistry, html, signal } from "../../src/index.js";

/** A counter live component factory (fresh state per mount). */
function counter() {
	const count = signal(0);
	return {
		view: html`<b>Count: ${count}</b>`,
		handlers: { increment: () => count(count() + 1) },
	};
}

describe("aurora > live registry", () => {
	it("defines + mounts a session that renders", () => {
		const reg = createLiveRegistry();
		reg.define("Counter", counter);
		expect(reg.has("Counter")).toBe(true);

		const { id, session } = reg.mount("Counter", "alice");
		expect(typeof id).toBe("string");
		expect(session.renderToString()).toContain("Count: 0");
		expect(reg.size()).toBe(1);
		reg.disposeAll();
	});

	it("mounting an unknown component throws (fail loud)", () => {
		const reg = createLiveRegistry();
		expect(() => reg.mount("Ghost", "alice")).toThrow(/unknown live component/);
	});

	it("get(id) routes an event to the right session", () => {
		const reg = createLiveRegistry();
		reg.define("Counter", counter);
		const { id } = reg.mount("Counter", "alice");

		reg.get(id)?.dispatch("increment");
		expect(reg.get(id)?.drainPatches()).toEqual([{ slot: 0, value: "1" }]);
		reg.disposeAll();
	});

	it("each mount has independent per-session state", () => {
		const reg = createLiveRegistry();
		reg.define("Counter", counter);
		const a = reg.mount("Counter", "alice");
		const b = reg.mount("Counter", "bob");

		a.session.dispatch("increment");
		a.session.dispatch("increment");
		b.session.dispatch("increment");

		expect(a.session.drainPatches()).toEqual([{ slot: 0, value: "2" }]);
		expect(b.session.drainPatches()).toEqual([{ slot: 0, value: "1" }]);
		reg.disposeAll();
	});

	it("dispose(id) removes one session", () => {
		const reg = createLiveRegistry();
		reg.define("Counter", counter);
		const { id } = reg.mount("Counter", "alice");
		expect(reg.size()).toBe(1);
		reg.dispose(id);
		expect(reg.size()).toBe(0);
		expect(reg.get(id)).toBeUndefined();
	});

	it("disposeOwner tears down ALL of one owner's sessions, leaving others", () => {
		const reg = createLiveRegistry();
		reg.define("Counter", counter);
		reg.mount("Counter", "alice");
		reg.mount("Counter", "alice"); // alice has two live components on her page
		const bob = reg.mount("Counter", "bob");
		expect(reg.size()).toBe(3);

		reg.disposeOwner("alice"); // alice disconnected
		expect(reg.size()).toBe(1);
		expect(reg.get(bob.id)).toBeDefined(); // bob untouched
		reg.disposeAll();
	});

	it("a disposed session stops tracking (effects freed)", () => {
		const reg = createLiveRegistry();
		reg.define("Counter", counter);
		const { id, session } = reg.mount("Counter", "alice");
		reg.dispose(id);
		session.dispatch("increment"); // handler runs but effects are gone
		expect(session.drainPatches()).toEqual([]);
	});

	it("disposeAll empties the registry", () => {
		const reg = createLiveRegistry();
		reg.define("Counter", counter);
		reg.mount("Counter", "alice");
		reg.mount("Counter", "bob");
		expect(reg.size()).toBe(2);
		reg.disposeAll();
		expect(reg.size()).toBe(0);
	});
});
