import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relay } from "../../src/relay.js";

/**
 * The relay uid belongs to the stream that announced it. A second `connected`
 * frame on the same stream — forgeable through a broadcast written raw into the
 * SSE frame — used to re-subscribe every channel to the uid it named, with the
 * victim's cookies and XSRF header: the victim's private channels moved onto
 * the attacker's connection.
 */

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	readonly listeners = new Map<string, (ev: unknown) => void>();
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

	connected(uid: unknown): void {
		this.listeners.get("connected")?.({ data: JSON.stringify({ uid }) });
	}

	raw(type: string, data: string): void {
		this.listeners.get(type)?.({ data });
	}

	drop(): void {
		this.listeners.get("error")?.({});
	}
}

const VICTIM = "6f1c1c4e-3d2a-4b8e-9a51-0c7d2e9f4a10";
const ATTACKER = "0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b";
const NEXT = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

const flush = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve));

let posts: Array<{ url: string; uid: unknown; channel: unknown }>;
let warn: ReturnType<typeof vi.spyOn>;

function stream(): FakeEventSource {
	const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
	if (!es) throw new Error("expected an EventSource");
	return es;
}

beforeEach(() => {
	posts = [];
	vi.stubGlobal("EventSource", FakeEventSource);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { body?: string }) => {
			const body: unknown = JSON.parse(init?.body ?? "{}");
			posts.push({
				url,
				uid: Reflect.get(Object(body), "uid"),
				channel: Reflect.get(Object(body), "channel"),
			});
			return { ok: true, status: 200 };
		}),
	);
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	relay().close();
	FakeEventSource.instances.length = 0;
	warn.mockRestore();
	vi.unstubAllGlobals();
});

describe("aurora/relay > the uid is bound to its stream", () => {
	it("ignores a second connected frame on the same stream", async () => {
		relay().subscribe("private-user.42", () => {});
		stream().connected(VICTIM);
		await flush();
		stream().connected(ATTACKER);
		await flush();
		expect(posts.map((p) => p.uid)).toEqual([VICTIM]);
		// Later subscriptions still use the stream's own uid.
		relay().subscribe("other", () => {});
		await flush();
		expect(posts.at(-1)?.uid).toBe(VICTIM);
		expect(warn).toHaveBeenCalled();
	});

	it("accepts a new uid after the stream dropped and reconnected", async () => {
		relay().subscribe("private-user.42", () => {});
		stream().connected(VICTIM);
		await flush();
		stream().drop();
		stream().connected(NEXT);
		await flush();
		expect(posts.map((p) => p.uid)).toEqual([VICTIM, NEXT]);
	});

	it("does not post with the old uid while reconnecting", async () => {
		relay().subscribe("a", () => {});
		stream().connected(VICTIM);
		await flush();
		stream().drop();
		relay().subscribe("b", () => {});
		await flush();
		expect(posts.map((p) => p.channel)).toEqual(["a"]);
		stream().connected(NEXT);
		await flush();
		expect(posts.slice(1).map((p) => [p.channel, p.uid])).toEqual([
			["a", NEXT],
			["b", NEXT],
		]);
	});

	it("refuses a uid that is not one the relay issues", async () => {
		relay().subscribe("a", () => {});
		for (const bad of ["", "x", "../../admin", 42, `${VICTIM}\nX`]) {
			stream().connected(bad);
		}
		await flush();
		expect(posts).toEqual([]);
		stream().connected(VICTIM);
		await flush();
		expect(posts.map((p) => p.uid)).toEqual([VICTIM]);
	});
});

describe("aurora/relay > undecodable payloads", () => {
	it("warns once per channel instead of dropping them silently", async () => {
		const received: unknown[] = [];
		relay().subscribe("news", (event) => received.push(event));
		stream().connected(VICTIM);
		await flush();
		stream().raw("news", "plain text not json");
		stream().raw("news", "still not json");
		stream().raw("news", JSON.stringify({ n: 1 }));
		expect(received).toEqual([{ n: 1 }]);
		const about = warn.mock.calls.filter((call: unknown[]) =>
			String(call[0]).includes("news"),
		);
		expect(about).toHaveLength(1);
	});

	it("delivers a JSON null rather than dropping it", async () => {
		const received: unknown[] = [];
		relay().subscribe("news", (event) => received.push(event));
		stream().connected(VICTIM);
		await flush();
		stream().raw("news", "null");
		expect(received).toEqual([null]);
	});
});
