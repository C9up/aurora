/**
 * Live router (Stage 4) — server-side orchestration over registry + relay:
 * mount → render + channel, event → dispatch + broadcast, disconnect → teardown.
 */
import { describe, expect, it } from "vitest";
import {
	createLiveRegistry,
	createLiveRouter,
	html,
	type RelayBroadcaster,
	signal,
} from "../../src/index.js";

function fakeRelay() {
	const sent: Array<{ channel: string; data: unknown }> = [];
	return {
		sent,
		broadcast(channel: string, data: unknown): number {
			sent.push({ channel, data });
			return 1;
		},
	} satisfies RelayBroadcaster & { sent: Array<{ channel: string; data: unknown }> };
}

function setup() {
	const reg = createLiveRegistry();
	reg.define("Counter", () => {
		const count = signal(0);
		return {
			view: html`<b>Count: ${count}</b>`,
			handlers: { increment: () => count(count() + 1) },
		};
	});
	const relay = fakeRelay();
	return { router: createLiveRouter(reg, relay), reg, relay };
}

describe("aurora > live router", () => {
	it("mount returns the initial render + a per-session channel", () => {
		const { router } = setup();
		const m = router.mount("Counter", "alice");
		expect(m.html).toContain("Count: 0");
		expect(m.channel).toBe(`live/${m.id}`);
		expect(router.channelFor(m.id)).toBe(m.channel);
	});

	it("event routes to the session and broadcasts the patch on its channel", () => {
		const { router, relay } = setup();
		const m = router.mount("Counter", "alice");
		const handled = router.event(m.id, "increment");
		expect(handled).toBe(true);
		expect(relay.sent).toEqual([
			{ channel: m.channel, data: [{ slot: 0, value: "1" }] },
		]);
	});

	it("event for an unknown id returns false and broadcasts nothing", () => {
		const { router, relay } = setup();
		expect(router.event("nope", "increment")).toBe(false);
		expect(relay.sent).toHaveLength(0);
	});

	it("disconnect disposes the owner's sessions — later events are no-ops", () => {
		const { router, reg, relay } = setup();
		const m = router.mount("Counter", "alice");
		router.mount("Counter", "alice"); // two components on alice's page
		expect(reg.size()).toBe(2);

		router.disconnect("alice");
		expect(reg.size()).toBe(0);
		expect(router.event(m.id, "increment")).toBe(false); // session gone
		expect(relay.sent).toHaveLength(0);
	});

	it("two owners are isolated", () => {
		const { router, relay } = setup();
		const a = router.mount("Counter", "alice");
		const b = router.mount("Counter", "bob");
		router.event(a.id, "increment");
		router.event(a.id, "increment");
		router.event(b.id, "increment");
		// Each session counts independently; broadcasts land on distinct channels.
		expect(relay.sent).toEqual([
			{ channel: a.channel, data: [{ slot: 0, value: "1" }] },
			{ channel: a.channel, data: [{ slot: 0, value: "2" }] },
			{ channel: b.channel, data: [{ slot: 0, value: "1" }] },
		]);
	});
});
