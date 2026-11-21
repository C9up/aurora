/**
 * @vitest-environment node
 */

/**
 * relay where there is no `EventSource` and no page — an app on a phone: the
 * platform hands the stream and the requests to `configureRelay`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	configureRelay,
	type RelayStreamEvent,
	relay,
} from "../../src/relay.js";

const UID = "11111111-1111-4111-8111-111111111111";

class Stream {
	readonly listeners = new Map<string, Array<(ev: RelayStreamEvent) => void>>();
	closed = false;
	constructor(readonly url: string) {}
	addEventListener(type: string, fn: (ev: RelayStreamEvent) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	close(): void {
		this.closed = true;
	}
	fire(type: string, data: unknown): void {
		for (const fn of this.listeners.get(type) ?? [])
			fn({ data: JSON.stringify(data) });
	}
}

afterEach(() => {
	relay().close();
});

describe("aurora/relay with a platform's stream and fetch", () => {
	it("opens the given stream, posts the handshake through the given fetch, and delivers", async () => {
		expect(typeof Reflect.get(globalThis, "EventSource")).toBe("undefined");
		const streams: Stream[] = [];
		const posts: Array<{ url: string; body: unknown }> = [];
		configureRelay({
			sseUrl: "https://app.example/__relay/events",
			subscribeUrl: "https://app.example/__relay/subscribe",
			stream: (url) => {
				const stream = new Stream(url);
				streams.push(stream);
				return stream;
			},
			fetch: async (url, init) => {
				posts.push({ url, body: JSON.parse(String(init.body)) });
				return new Response(null, { status: 204 });
			},
		});
		const seen: unknown[] = [];
		relay().subscribe("orders", (event) => seen.push(event));
		const stream = streams[0];
		expect(stream?.url).toBe("https://app.example/__relay/events");

		stream?.fire("connected", { uid: UID });
		await vi.waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).toEqual({
			url: "https://app.example/__relay/subscribe",
			body: { uid: UID, channel: "orders" },
		});

		stream?.fire("orders", { id: 7 });
		expect(seen).toEqual([{ id: 7 }]);
	});
});
