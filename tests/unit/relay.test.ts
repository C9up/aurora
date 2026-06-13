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
});
