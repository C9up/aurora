import { describe, expect, it, vi } from "vitest";
import {
	batch,
	effect,
	isSignal,
	memo,
	onCleanup,
	signal,
	untrack,
} from "../../src/reactive.js";

describe("aurora > reactive > signal", () => {
	it("returns the initial value on read", () => {
		const s = signal(42);
		expect(s()).toBe(42);
	});

	it("updates the stored value on write", () => {
		const s = signal(1);
		s(2);
		expect(s()).toBe(2);
	});

	it("accepts an updater function for writes", () => {
		const s = signal(10);
		s((prev) => prev + 5);
		expect(s()).toBe(15);
	});

	it("does not notify when the new value equals the old (Object.is)", () => {
		const s = signal(7);
		let runs = 0;
		effect(() => {
			s();
			runs++;
		});
		expect(runs).toBe(1);
		s(7); // same value
		expect(runs).toBe(1);
	});

	it("honors a custom equality function", () => {
		const s = signal({ count: 0 }, { equals: (a, b) => a.count === b.count });
		let runs = 0;
		effect(() => {
			s();
			runs++;
		});
		s({ count: 0 }); // structurally same → skip
		expect(runs).toBe(1);
		s({ count: 1 });
		expect(runs).toBe(2);
	});

	it("isSignal distinguishes signals from plain functions", () => {
		const s = signal(0);
		expect(isSignal(s)).toBe(true);
		expect(isSignal(() => 0)).toBe(false);
		expect(isSignal(0)).toBe(false);
		expect(isSignal(null)).toBe(false);
	});
});

describe("aurora > reactive > effect", () => {
	it("runs the callback eagerly on creation", () => {
		const fn = vi.fn();
		effect(fn);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("re-runs when a tracked signal changes", () => {
		const s = signal(0);
		const fn = vi.fn(() => {
			s();
		});
		effect(fn);
		s(1);
		s(2);
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("stops re-running after dispose", () => {
		const s = signal(0);
		const fn = vi.fn(() => {
			s();
		});
		const dispose = effect(fn);
		dispose();
		s(99);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("runs cleanup before the next execution and at dispose", () => {
		const s = signal(0);
		const cleanup = vi.fn();
		const dispose = effect(() => {
			s();
			return cleanup;
		});
		expect(cleanup).toHaveBeenCalledTimes(0);
		s(1);
		expect(cleanup).toHaveBeenCalledTimes(1);
		s(2);
		expect(cleanup).toHaveBeenCalledTimes(2);
		dispose();
		expect(cleanup).toHaveBeenCalledTimes(3);
	});

	it("collects multiple onCleanup registrations", () => {
		const s = signal(0);
		const a = vi.fn();
		const b = vi.fn();
		const dispose = effect(() => {
			s();
			onCleanup(a);
			onCleanup(b);
		});
		s(1);
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
		dispose();
		expect(a).toHaveBeenCalledTimes(2);
		expect(b).toHaveBeenCalledTimes(2);
	});

	it("a cleanup that throws does not block sibling cleanups", () => {
		const s = signal(0);
		const a = vi.fn(() => {
			throw new Error("boom");
		});
		const b = vi.fn();
		effect(() => {
			s();
			onCleanup(a);
			onCleanup(b);
		});
		s(1);
		expect(a).toHaveBeenCalled();
		expect(b).toHaveBeenCalled();
	});

	it("re-collects dependencies on every run (no stale subscriptions)", () => {
		const a = signal(0);
		const b = signal(100);
		const which = signal<"a" | "b">("a");
		let lastValue = -1;
		effect(() => {
			lastValue = which() === "a" ? a() : b();
		});
		expect(lastValue).toBe(0);
		a(1);
		expect(lastValue).toBe(1);
		which("b");
		expect(lastValue).toBe(100);
		// Now `a` is no longer a dependency — writing it should NOT re-run.
		const before = lastValue;
		a(999);
		expect(lastValue).toBe(before);
		b(200);
		expect(lastValue).toBe(200);
	});
});

describe("aurora > reactive > batch", () => {
	it("coalesces multiple writes into a single effect run", () => {
		const a = signal(0);
		const b = signal(0);
		const fn = vi.fn(() => {
			a();
			b();
		});
		effect(fn);
		expect(fn).toHaveBeenCalledTimes(1);
		batch(() => {
			a(1);
			b(2);
			a(3);
		});
		expect(fn).toHaveBeenCalledTimes(2); // 1 eager + 1 batched
		expect(a()).toBe(3);
		expect(b()).toBe(2);
	});

	it("nested batches flush only at the outermost return", () => {
		const a = signal(0);
		const fn = vi.fn(() => {
			a();
		});
		effect(fn);
		batch(() => {
			a(1);
			batch(() => a(2));
			a(3); // outer batch still open — no flush
		});
		expect(fn).toHaveBeenCalledTimes(2); // 1 eager + 1 outer flush
	});

	it("returns the inner function's value", () => {
		expect(batch(() => 42)).toBe(42);
	});
});

describe("aurora > reactive > untrack", () => {
	it("reads inside untrack do not register dependencies", () => {
		const tracked = signal(0);
		const ignored = signal(0);
		const fn = vi.fn(() => {
			tracked();
			untrack(() => ignored());
		});
		effect(fn);
		ignored(1); // would re-run if tracked
		expect(fn).toHaveBeenCalledTimes(1);
		tracked(1);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("returns the inner function's value", () => {
		const s = signal("hello");
		const v = untrack(() => s());
		expect(v).toBe("hello");
	});

	it("does not leak dead observers onto the signal across repeated reads", async () => {
		const { _observerCount } = await import("../../src/reactive.js");
		const s = signal(0);
		// Many untrack reads — each used to push a dummy observer that was
		// add()-ed to the signal's observer Set and never removed.
		for (let i = 0; i < 50; i += 1) {
			untrack(() => s());
		}
		// Reading outside any effect registers nothing either. The Set
		// must stay empty — no accumulation.
		expect(_observerCount(s)).toBe(0);
	});

	it("untrack read inside a live effect registers neither the effect nor a dummy", async () => {
		const { _observerCount } = await import("../../src/reactive.js");
		const tracked = signal(1);
		const ignored = signal(1);
		effect(() => {
			tracked();
			untrack(() => ignored());
		});
		// `tracked` has the effect as an observer; `ignored` has none.
		expect(_observerCount(tracked)).toBe(1);
		expect(_observerCount(ignored)).toBe(0);
	});
});

describe("aurora > reactive > memo", () => {
	it("derives a read-only signal from dependencies", () => {
		const a = signal(2);
		const b = signal(3);
		const sum = memo(() => a() + b());
		expect(sum()).toBe(5);
		a(10);
		expect(sum()).toBe(13);
	});

	it("recomputes only when an upstream signal changes", () => {
		const a = signal(1);
		const fn = vi.fn((): number => a() * 2);
		const doubled = memo(fn);
		doubled();
		doubled();
		doubled();
		expect(fn).toHaveBeenCalledTimes(1);
		a(2);
		expect(doubled()).toBe(4);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("propagates through downstream effects", () => {
		const a = signal(1);
		const doubled = memo(() => a() * 2);
		const seen: number[] = [];
		effect(() => {
			seen.push(doubled());
		});
		a(2);
		a(3);
		expect(seen).toEqual([2, 4, 6]);
	});
});
