import { describe, expect, it } from "vitest";
import { command } from "../../src/command.js";

/** A promise plus its resolve/reject, for deterministic ordering in tests. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("aurora > command", () => {
	it("run() success: toggles loading, sets data, fires onSuccess", async () => {
		const seen: number[] = [];
		const cmd = command((n: number) => Promise.resolve(n * 2)).onSuccess((d) =>
			seen.push(d),
		);
		expect(cmd.loading()).toBe(false);
		const p = cmd.run(3);
		expect(cmd.loading()).toBe(true);
		await p;
		expect(cmd.loading()).toBe(false);
		expect(cmd.data()).toBe(6);
		expect(cmd.error()).toBeNull();
		expect(seen).toEqual([6]);
	});

	it("run() failure: sets error, fires onFail, never throws", async () => {
		const err = new Error("boom");
		const seen: unknown[] = [];
		const cmd = command(() => Promise.reject(err)).onFail((e) => seen.push(e));
		await expect(cmd.run()).resolves.toBeUndefined();
		expect(cmd.error()).toBe(err);
		expect(cmd.data()).toBeNull();
		expect(cmd.loading()).toBe(false);
		expect(seen).toEqual([err]);
	});

	it("re-runs with different params; data reflects the latest", async () => {
		const calls: number[] = [];
		const cmd = command((n: number) => {
			calls.push(n);
			return Promise.resolve(n);
		});
		await cmd.run(1);
		await cmd.run(2);
		await cmd.run(3);
		expect(calls).toEqual([1, 2, 3]);
		expect(cmd.data()).toBe(3);
	});

	it("a superseded (slower) run does not overwrite the latest", async () => {
		const first = deferred<string>();
		const second = deferred<string>();
		const queue = [first, second];
		const seen: string[] = [];
		const cmd = command((_label: string) => {
			const d = queue.shift();
			if (!d) throw new Error("unexpected run");
			return d.promise;
		}).onSuccess((d) => seen.push(d));

		const p1 = cmd.run("first");
		const p2 = cmd.run("second");

		// Resolve the LATEST run first, then the stale one.
		second.resolve("second-data");
		await p2;
		expect(cmd.data()).toBe("second-data");
		expect(cmd.loading()).toBe(false);

		first.resolve("first-data"); // stale — must be dropped
		await p1;
		expect(cmd.data()).toBe("second-data"); // unchanged
		expect(seen).toEqual(["second-data"]); // stale onSuccess never fired
	});

	it("onSettled runs after success and after failure", async () => {
		let settled = 0;
		const ok = command(() => Promise.resolve("x")).onSettled(() => settled++);
		await ok.run();
		const bad = command(() => Promise.reject(new Error("e"))).onSettled(
			() => settled++,
		);
		await bad.run();
		expect(settled).toBe(2);
	});

	it("reset() clears state", async () => {
		const cmd = command(() => Promise.resolve("x"));
		await cmd.run();
		expect(cmd.data()).toBe("x");
		cmd.reset();
		expect(cmd.data()).toBeNull();
		expect(cmd.error()).toBeNull();
		expect(cmd.loading()).toBe(false);
	});

	it("registration methods are chainable and return the command", () => {
		const cmd = command(() => Promise.resolve(1));
		expect(
			cmd
				.onSuccess(() => {})
				.onFail(() => {})
				.onSettled(() => {}),
		).toBe(cmd);
	});
});
