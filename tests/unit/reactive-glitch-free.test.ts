/**
 * The reactive core runs an observer once per change, never against a
 * half-updated graph, and never after the scope that made it is gone.
 *
 * A memo recomputed as soon as its source was written and pushed its new value
 * to its observers from inside that write: an effect reading a signal and a
 * memo derived from it ran once for the signal and again for the memo, the
 * first time with the memo's stale value. `batch` did not help, because the
 * memo's own write flushed outside it. An effect or memo created inside
 * another effect's run (a slot accessor, an `onMount`) had no owner and kept
 * running after the run that made it was replaced.
 */

import { describe, expect, it } from "vitest";
import {
	batch,
	effect,
	memo,
	onCleanup,
	signal,
	untrack,
} from "../../src/reactive.js";

describe("diamond dependencies", () => {
	it("an effect reading a signal and a memo of it runs once per write, with both fresh", () => {
		const a = signal(1);
		const double = memo(() => a() * 2);
		const seen: string[] = [];
		effect(() => {
			seen.push(`${a()}:${double()}`);
		});
		a(2);
		expect(seen).toEqual(["1:2", "2:4"]);
	});

	it("an effect reading two memos of one signal runs once per write", () => {
		const a = signal(1);
		const b = memo(() => a() + 1);
		const c = memo(() => a() * 10);
		const seen: string[] = [];
		effect(() => {
			seen.push(`${b()}:${c()}`);
		});
		a(2);
		expect(seen).toEqual(["2:10", "3:20"]);
	});

	it("a memo over two memos of one signal recomputes once per write", () => {
		const a = signal(1);
		const b = memo(() => a() + 1);
		const c = memo(() => a() * 10);
		let runs = 0;
		const d = memo(() => {
			runs++;
			return b() + c();
		});
		effect(() => {
			d();
		});
		runs = 0;
		a(2);
		expect(runs).toBe(1);
		expect(d()).toBe(23);
	});

	it("chains of different depth settle before any effect runs", () => {
		const a = signal(1);
		const b = memo(() => a() + 1);
		const c = memo(() => b() + 1);
		const seen: string[] = [];
		effect(() => {
			seen.push(`${a()}:${c()}`);
		});
		a(5);
		expect(seen).toEqual(["1:3", "5:7"]);
	});

	it("inside a batch, an effect over a signal and its memo runs once", () => {
		const a = signal(1);
		const b = signal(1);
		const sum = memo(() => a() + b());
		const seen: number[] = [];
		effect(() => {
			seen.push(a() + sum());
		});
		batch(() => {
			a(2);
			b(2);
		});
		expect(seen).toEqual([3, 6]);
	});
});

describe("memo cut-off", () => {
	it("a memo that recomputes to the same value re-runs nothing downstream", () => {
		const n = signal(1);
		const parity = memo(() => n() % 2);
		let runs = 0;
		effect(() => {
			parity();
			runs++;
		});
		n(3);
		n(5);
		expect(runs).toBe(1);
	});

	it("a memo read after its source was written in the same batch is fresh", () => {
		const a = signal(1);
		const double = memo(() => a() * 2);
		const read = batch(() => {
			a(4);
			return double();
		});
		expect(read).toBe(8);
	});
});

describe("ownership of what an effect creates", () => {
	it("an effect created inside an effect ends when the outer one re-runs", () => {
		const outer = signal(0);
		const inner = signal(0);
		let innerRuns = 0;
		effect(() => {
			outer();
			effect(() => {
				inner();
				innerRuns++;
			});
		});
		outer(1);
		outer(2);
		innerRuns = 0;
		inner(1);
		// Only the effect made by the latest outer run is alive.
		expect(innerRuns).toBe(1);
	});

	it("a memo created inside an effect stops recomputing when the effect ends", () => {
		const source = signal(0);
		let computations = 0;
		const dispose = effect(() => {
			memo(() => {
				computations++;
				return source();
			});
		});
		dispose();
		computations = 0;
		source(1);
		expect(computations).toBe(0);
	});

	it("an effect's onCleanup still runs before its next run", () => {
		const s = signal(0);
		const log: string[] = [];
		effect(() => {
			const v = s();
			onCleanup(() => log.push(`clean ${v}`));
		});
		s(1);
		expect(log).toEqual(["clean 0"]);
	});
});

describe("order of a parent and the child it owns", () => {
	it("a child effect is not run against a state its parent is about to remove", () => {
		const user = signal<{ name: string } | null>({ name: "Ada" });
		const names: string[] = [];
		effect(() => {
			if (untrack(() => user()) !== null) {
				effect(() => {
					const current = user();
					if (current === null) throw new Error("child ran after logout");
					names.push(current.name);
				});
			}
			// The parent subscribes AFTER the child it made: the order a page
			// gets when the parent's condition is read late or re-subscribed.
			user();
		});
		expect(() => user(null)).not.toThrow();
		expect(names).toEqual(["Ada"]);
	});
});
