import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureRelay, type RelayStatus, relay } from "../../src/relay.js";

/**
 * The relay's wire contract on the client side:
 *
 * - a stream belongs to the user and session that opened it, and a subscribe
 *   or unsubscribe carrying other credentials answers `403 E_RELAY_NOT_OWNER`
 *   (a stream opened before login, or before the session cookie existed). The
 *   client opens a new stream, which is bound to its current credentials, and
 *   subscribes its channels again — once, never in a loop;
 * - a connection over a cap gets an `error` frame naming the cap, then the end
 *   of the stream: `E_RELAY_MAX_CLIENTS` and `E_RELAY_MAX_CLIENTS_PER_OWNER`
 *   are handled the same way;
 * - a broadcast payload is JSON, a string included.
 */

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	closed = false;

	constructor(public readonly url: string) {
		FakeEventSource.instances.push(this);
	}

	addEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}

	close(): void {
		this.closed = true;
	}

	fire(type: string, ev: unknown): void {
		for (const fn of this.listeners.get(type) ?? []) fn(ev);
	}

	connected(uid: string): void {
		this.fire("connected", { data: JSON.stringify({ uid }) });
	}
}

const UID_1 = "11111111-1111-4111-8111-111111111111";
const UID_2 = "22222222-2222-4222-8222-222222222222";
const UID_3 = "33333333-3333-4333-8333-333333333333";

const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r));
};

function latest(): FakeEventSource {
	const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
	if (!es) throw new Error("expected an EventSource");
	return es;
}

function notOwner(): Response {
	return new Response(
		JSON.stringify({
			error: { code: "E_RELAY_NOT_OWNER", message: "E_RELAY_NOT_OWNER" },
		}),
		{ status: 403, headers: { "content-type": "application/json" } },
	);
}

let posts: Array<{ url: string; uid: unknown; channel: unknown }>;
let answer: (url: string, uid: unknown) => Response;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	posts = [];
	answer = () => new Response(null, { status: 204 });
	vi.stubGlobal("EventSource", FakeEventSource);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { body?: string }) => {
			const body: unknown = JSON.parse(init?.body ?? "{}");
			const uid = Reflect.get(Object(body), "uid");
			posts.push({ url, uid, channel: Reflect.get(Object(body), "channel") });
			return answer(url, uid);
		}),
	);
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	relay().close();
	configureRelay({ maxReconnectAttempts: 5 });
	FakeEventSource.instances.length = 0;
	warn.mockRestore();
	vi.unstubAllGlobals();
});

describe("aurora/relay > E_RELAY_NOT_OWNER", () => {
	it("opens a new stream and subscribes its channels again", async () => {
		relay().subscribe("a", () => {});
		relay().subscribe("b", () => {});
		const first = latest();
		// The stream predates the login: it refuses this session's requests.
		answer = (_url, uid) =>
			uid === UID_1 ? notOwner() : new Response(null, { status: 204 });
		first.connected(UID_1);
		await flush();
		expect(first.closed).toBe(true);
		const second = latest();
		expect(second).not.toBe(first);
		second.connected(UID_2);
		await flush();
		expect(posts.filter((p) => p.uid === UID_2).map((p) => p.channel)).toEqual([
			"a",
			"b",
		]);
		expect(FakeEventSource.instances).toHaveLength(2);
	});

	it("reopens once, not in a loop, when the new stream refuses too", async () => {
		relay().subscribe("a", () => {});
		answer = () => notOwner();
		latest().connected(UID_1);
		await flush();
		latest().connected(UID_2);
		await flush();
		expect(FakeEventSource.instances).toHaveLength(2);
		expect(latest().closed).toBe(false);
		expect(
			warn.mock.calls.some((call: unknown[]) =>
				String(call[1] ?? call[0]).includes("E_RELAY_NOT_OWNER"),
			),
		).toBe(true);
	});

	it("can reopen again after a stream that was accepted", async () => {
		relay().subscribe("a", () => {});
		answer = (_url, uid) =>
			uid === UID_1 ? notOwner() : new Response(null, { status: 204 });
		latest().connected(UID_1);
		await flush();
		latest().connected(UID_2);
		await flush();
		// A later login makes the accepted stream stale in turn.
		answer = (_url, uid) =>
			uid === UID_3 ? new Response(null, { status: 204 }) : notOwner();
		relay().subscribe("c", () => {});
		await flush();
		expect(FakeEventSource.instances).toHaveLength(3);
		latest().connected(UID_3);
		await flush();
		expect(posts.filter((p) => p.uid === UID_3).map((p) => p.channel)).toEqual([
			"a",
			"c",
		]);
	});

	it("reopens on a refused unsubscribe too", async () => {
		const off = relay().subscribe("a", () => {});
		relay().subscribe("b", () => {});
		latest().connected(UID_1);
		await flush();
		answer = (url) =>
			url.includes("unsubscribe")
				? notOwner()
				: new Response(null, { status: 204 });
		off();
		await flush();
		expect(FakeEventSource.instances).toHaveLength(2);
		latest().connected(UID_2);
		await flush();
		expect(posts.filter((p) => p.uid === UID_2).map((p) => p.channel)).toEqual([
			"b",
		]);
	});
});

describe("aurora/relay > a capped connection", () => {
	for (const code of ["E_RELAY_MAX_CLIENTS", "E_RELAY_MAX_CLIENTS_PER_OWNER"]) {
		it(`counts ${code} as one failed attempt and gives up at the limit`, () => {
			const failed = vi.fn();
			configureRelay({ maxReconnectAttempts: 2, onReconnectFailed: failed });
			const statuses: RelayStatus[] = [];
			relay().on("reconnecting", (s) => statuses.push(s));
			const es = latest();
			for (let i = 0; i < 3; i++) {
				// The refusal frame, then the end of the stream.
				es.fire("error", { data: JSON.stringify({ code }) });
				es.fire("error", {});
			}
			expect(failed).toHaveBeenCalledTimes(1);
			expect(es.closed).toBe(true);
			expect(statuses).toHaveLength(3);
			const named = warn.mock.calls.filter((call: unknown[]) =>
				String(call[0]).includes(code),
			);
			expect(named).toHaveLength(1);
		});
	}
});

describe("aurora/relay > string payloads", () => {
	it("delivers a JSON-encoded string as the string", async () => {
		const received: unknown[] = [];
		relay().subscribe("news", (event) => received.push(event));
		latest().connected(UID_1);
		await flush();
		latest().fire("news", { data: JSON.stringify("hello\r\nevent: x") });
		expect(received).toEqual(["hello\r\nevent: x"]);
	});
});
