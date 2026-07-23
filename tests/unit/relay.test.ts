import { afterEach, describe, expect, it, vi } from "vitest";
import { configureRelay, type RelayStatus, relay } from "../../src/relay.js";

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
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

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

interface CapturedFetch {
	url: string;
	body: { uid?: string; channel?: string };
	headers: Record<string, string>;
	credentials?: string;
}

/** fetch double that records url + parsed body + headers + credentials. */
function captureFetch(): {
	mock: ReturnType<typeof vi.fn>;
	calls: CapturedFetch[];
} {
	const calls: CapturedFetch[] = [];
	const mock = vi.fn(
		async (
			url: string,
			init?: {
				body?: string;
				headers?: Record<string, string>;
				credentials?: string;
			},
		) => {
			calls.push({
				url,
				body: JSON.parse(init?.body ?? "{}"),
				headers: init?.headers ?? {},
				credentials: init?.credentials,
			});
			return { ok: true, status: 200 };
		},
	);
	return { mock, calls };
}

describe("aurora/relay > unsubscribe on last handler", () => {
	afterEach(() => {
		relay().close();
		FakeEventSource.instances.length = 0;
		vi.unstubAllGlobals();
	});

	it("POSTs /__relay/unsubscribe when the LAST handler for a channel detaches", async () => {
		const { mock, calls } = captureFetch();
		vi.stubGlobal("EventSource", FakeEventSource);
		vi.stubGlobal("fetch", mock);

		const client = relay();
		const off1 = client.subscribe("room/1", () => {});
		const off2 = client.subscribe("room/1", () => {});

		const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
		if (!es) throw new Error("expected an EventSource");
		es.emitConnected("uid-1");
		await flush();

		// First detach: another handler remains → NO unsubscribe.
		off1();
		await flush();
		expect(calls.some((c) => c.url === "/__relay/unsubscribe")).toBe(false);

		// Last detach: channel is now empty → unsubscribe fires.
		off2();
		await flush();
		const unsub = calls.filter((c) => c.url === "/__relay/unsubscribe");
		expect(unsub).toHaveLength(1);
		expect(unsub[0]?.body).toEqual({ uid: "uid-1", channel: "room/1" });
	});
});

describe("aurora/relay > CSRF handshake", () => {
	afterEach(() => {
		relay().close();
		FakeEventSource.instances.length = 0;
		vi.unstubAllGlobals();
		document.cookie = "XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
	});

	it("echoes the XSRF-TOKEN cookie as X-XSRF-TOKEN + credentials:'include' on POSTs", async () => {
		document.cookie = "XSRF-TOKEN=tok%20en-123";
		const { mock, calls } = captureFetch();
		vi.stubGlobal("EventSource", FakeEventSource);
		vi.stubGlobal("fetch", mock);

		const client = relay();
		client.subscribe("room/1", () => {});

		const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
		if (!es) throw new Error("expected an EventSource");
		es.emitConnected("uid-1");
		await flush();

		const sub = calls.find((c) => c.url === "/__relay/subscribe");
		if (!sub) throw new Error("expected a subscribe POST");
		// Cookie value is URL-decoded before it rides in the header.
		expect(sub.headers["x-xsrf-token"]).toBe("tok en-123");
		expect(sub.credentials).toBe("include");
	});

	it("does not throw when the XSRF-TOKEN cookie contains malformed percent encoding", async () => {
		document.cookie = "XSRF-TOKEN=%";
		const { mock, calls } = captureFetch();
		vi.stubGlobal("EventSource", FakeEventSource);
		vi.stubGlobal("fetch", mock);

		const client = relay();
		client.subscribe("room/1", () => {});

		const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
		if (!es) throw new Error("expected an EventSource");
		es.emitConnected("uid-1");
		await flush();

		const sub = calls.find((c) => c.url === "/__relay/subscribe");
		expect(sub?.headers["x-xsrf-token"]).toBe("%");
	});
});

describe("aurora/relay > status + reconnect events", () => {
	afterEach(() => {
		relay().close();
		FakeEventSource.instances.length = 0;
		vi.unstubAllGlobals();
		configureRelay({ maxReconnectAttempts: 5 });
	});

	it("emits connecting → connected, then disconnected → reconnecting on error", async () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

		const seen: RelayStatus[] = [];
		// The very first open() (inside relay()) fires `connecting` before any
		// listener can attach — same as Transmit's constructor. Register the
		// listeners, then close + reopen so the reconnect `connecting` is
		// observed. close() keeps status listeners; it only drops channels/uid.
		const client = relay();
		const offs = (
			["connecting", "connected", "disconnected", "reconnecting"] as const
		).map((s) => client.on(s, (status) => seen.push(status)));
		client.close();
		relay(); // reopen → connecting (now observed)

		const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
		if (!es) throw new Error("expected an EventSource");
		es.emitConnected("uid-1"); // → connected
		await flush();
		es.listeners.get("error")?.({}); // native EventSource drop → disconnected + reconnecting

		expect(seen).toEqual([
			"connecting",
			"connected",
			"disconnected",
			"reconnecting",
		]);
		for (const off of offs) off();
	});

	it("counts reconnect attempts and fires onReconnectFailed once the cap is hit", async () => {
		const attempts: number[] = [];
		let failed = 0;
		configureRelay({
			maxReconnectAttempts: 1,
			onReconnectAttempt: (n) => attempts.push(n),
			onReconnectFailed: () => {
				failed++;
			},
		});
		vi.stubGlobal("EventSource", FakeEventSource);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);

		const client = relay();
		client.subscribe("room/1", () => {});
		const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
		if (!es) throw new Error("expected an EventSource");
		es.emitConnected("uid-1");
		await flush();

		es.listeners.get("error")?.({}); // attempt 1 (under cap)
		es.listeners.get("error")?.({}); // attempt 2 → cap reached → give up

		expect(attempts).toEqual([1, 2]);
		expect(failed).toBe(1);
		expect(es.closed).toBe(true); // native retry loop stopped
	});
});
