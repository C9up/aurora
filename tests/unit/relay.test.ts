import { afterEach, describe, expect, it, vi } from "vitest";
import { relay } from "../../src/relay.js";

/** Captures the SSE handshake so a test can drive `connected` (re)connects. */
class FakeEventSource {
	static instances: FakeEventSource[] = [];
	readonly listeners = new Map<string, (ev: unknown) => void>();
	onmessage: ((ev: unknown) => void) | null = null;
	closed = false;

	constructor(public readonly url: string) {
		FakeEventSource.instances.push(this);
	}

	addEventListener(type: string, fn: (ev: unknown) => void): void {
		this.listeners.set(type, fn);
	}

	close(): void {
		this.closed = true;
	}

	emitConnected(uid: string): void {
		this.listeners.get("connected")?.({ data: JSON.stringify({ uid }) });
	}

	/** Fire a named-channel broadcast — the relay's `event: <channel>` frame. */
	emit(channel: string, payload: unknown): void {
		this.listeners.get(channel)?.({ data: JSON.stringify(payload) });
	}
}

const flush = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve));

describe("aurora/relay", () => {
	afterEach(() => {
		relay().close();
		FakeEventSource.instances.length = 0;
		vi.unstubAllGlobals();
	});

	it("re-applies every subscription on each (re)connect, not just the first", async () => {
		const calls: Array<{ channel: string; uid: string }> = [];
		const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
			const body = JSON.parse(init?.body ?? "{}");
			calls.push({ channel: String(body.channel), uid: String(body.uid) });
			return { ok: true, status: 200 };
		});
		vi.stubGlobal("EventSource", FakeEventSource);
		vi.stubGlobal("fetch", fetchMock);

		const client = relay();
		client.subscribe("project/1", () => {});

		const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
		if (!es) throw new Error("expected an EventSource to be opened");

		es.emitConnected("uid-1"); // first connect
		await flush();
		es.emitConnected("uid-2"); // browser auto-reconnect — server forgot the sub
		await flush();

		const forChannel = calls.filter((c) => c.channel === "project/1");
		// Pre-fix: only 1 subscribe (first connect); the reconnect re-POSTs nothing.
		expect(forChannel).toHaveLength(2);
		expect(forChannel[1]?.uid).toBe("uid-2");
	});

	it("delivers a channel's NAMED broadcast payload verbatim to its handler", async () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));

		const received: unknown[] = [];
		const client = relay();
		client.subscribe<Array<{ slot: number; value: string }>>(
			"live/abc",
			(patch) => received.push(patch),
		);

		const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
		if (!es) throw new Error("expected an EventSource to be opened");
		es.emitConnected("uid-1");
		await flush();

		// The relay broadcasts `event: live/abc` (a NAMED event), not the default
		// `message` — so onmessage-based dispatch would miss it entirely.
		es.emit("live/abc", [{ slot: 0, value: "1" }]);

		expect(received).toEqual([[{ slot: 0, value: "1" }]]);
	});
});
