/**
 * Live broadcast (Stage 3) — patches piped onto a relay channel, and the shared
 * multiplayer store. Uses a local fake broadcaster (aurora stays
 * `@c9up/relay`-free) that records every broadcast.
 */
import { describe, expect, it } from "vitest";
import {
	connectPatches,
	html,
	liveStore,
	mountLiveSession,
	type RelayBroadcaster,
	signal,
} from "../../src/index.js";

/** Records broadcasts; mirrors the real `Relay.broadcast` signature. */
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

describe("aurora > live broadcast", () => {
	it("connectPatches pipes each patch to the channel", () => {
		const relay = fakeRelay();
		const count = signal(0);
		const session = mountLiveSession(() => ({
			view: html`<b>${count}</b>`,
			handlers: { inc: () => count(count() + 1) },
		}));
		const off = connectPatches(session, relay, "live/abc");

		session.dispatch("inc");
		session.dispatch("inc");
		expect(relay.sent).toEqual([
			{ channel: "live/abc", data: [{ slot: 0, value: "1" }] },
			{ channel: "live/abc", data: [{ slot: 0, value: "2" }] },
		]);

		off();
		session.dispatch("inc"); // unsubscribed → no further broadcast
		expect(relay.sent).toHaveLength(2);
		session.dispose();
	});

	it("liveStore: one dispatch → one broadcast (O(1) compute, relay fans out)", () => {
		const relay = fakeRelay();
		const online = signal(1);
		const store = liveStore(
			() => ({
				view: html`<span>${online} online</span>`,
				handlers: { join: () => online(online() + 1) },
			}),
			relay,
			"room/42",
		);

		expect(store.channel).toBe("room/42");
		expect(store.renderToString().replace(/<!--\/?\$-->/g, "")).toContain(
			"1 online",
		);

		store.dispatch("join"); // shared mutation, server-side
		// Exactly ONE broadcast — not one-per-client. Relay fans it out to all
		// subscribers on `room/42`.
		expect(relay.sent).toEqual([
			{ channel: "room/42", data: [{ slot: 0, value: "2" }] },
		]);
		expect(store.renderToString().replace(/<!--\/?\$-->/g, "")).toContain(
			"2 online",
		);
		store.dispose();
	});

	it("liveStore.dispose stops broadcasting", () => {
		const relay = fakeRelay();
		const n = signal(0);
		const store = liveStore(
			() => ({ view: html`<i>${n}</i>`, handlers: { inc: () => n(n() + 1) } }),
			relay,
			"room/x",
		);
		store.dispose();
		store.dispatch("inc");
		expect(relay.sent).toHaveLength(0);
	});
});
