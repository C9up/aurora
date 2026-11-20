/**
 * @internal The window of a lazy list, host-free: which rows exist, and how
 * tall the spacers standing in for the others are. The DOM renderer and a
 * native one read the viewport their own way and ask this the same question.
 */

/** A lazy list's settings, resolved (see `LazyOptions` in each.ts). */
export interface LazyList {
	estimate: number;
	overscan: number;
	from: "start" | "end";
}

/**
 * The viewport the rows are chosen for, in the list's own coordinates (0 is
 * the top of its first row): a span, or pinned to the end, `height` tall.
 */
export type LazyView =
	| { kind: "span"; from: number; to: number }
	| { kind: "end"; height: number };

export interface LazyWindow {
	/** The first row built. */
	start: number;
	/** One past the last row built. */
	end: number;
	/** What the rows above the window take. */
	before: number;
	/** What the rows below the window take. */
	after: number;
}

/**
 * The height a first frame is assumed to show before anything is measured:
 * the server renders the rows it takes, and the client starts from the same.
 */
const FIRST_VIEWPORT = 1000;

/** The rows the first frame builds: the server's window, adopted by the client. */
export function firstWindow(count: number, lazy: LazyList): [number, number] {
	const rows = Math.min(
		count,
		Math.ceil((FIRST_VIEWPORT + lazy.overscan) / lazy.estimate),
	);
	return lazy.from === "end" ? [count - rows, count] : [0, rows];
}

export function sameWindow(a: LazyWindow, b: LazyWindow): boolean {
	return (
		a.start === b.start &&
		a.end === b.end &&
		a.before === b.before &&
		a.after === b.after
	);
}

/** The first index of `offsets` holding more than `value` (its length if none). */
function firstAbove(offsets: Float64Array, value: number): number {
	let low = 0;
	let high = offsets.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if ((offsets[mid] ?? 0) > value) high = mid;
		else low = mid + 1;
	}
	return low;
}

/** The first index of `offsets` holding at least `value` (its length if none). */
function firstAtLeast(offsets: Float64Array, value: number): number {
	let low = 0;
	let high = offsets.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if ((offsets[mid] ?? 0) >= value) high = mid;
		else low = mid + 1;
	}
	return low;
}

/**
 * Row heights by key, measured where shown, estimated elsewhere.
 *
 * Where every row starts is kept as running sums, rebuilt only when the list
 * or a height changed: a scroll, many times a second, then finds its window
 * by binary search instead of walking thousands of rows — on a phone's
 * JavaScript engine that walk, once per scroll event, left the window behind
 * the finger.
 */
export class LazyLayout {
	readonly #lazy: LazyList;
	readonly #heights = new Map<unknown, number>();
	/** `offsets[i]` is where row i starts; `offsets[count]` the whole height. */
	#offsets = new Float64Array(1);
	#offsetsOf: readonly unknown[] | null = null;
	#stale = true;

	constructor(lazy: LazyList) {
		this.#lazy = lazy;
	}

	heightOf(key: unknown): number {
		return this.#heights.get(key) ?? this.#lazy.estimate;
	}

	/** Record a row's measured height; true when it changed what was assumed. */
	measure(key: unknown, height: number): boolean {
		if (!(Number.isFinite(height) && height >= 0)) return false;
		const previous = this.heightOf(key);
		if (previous !== height) this.#stale = true;
		this.#heights.set(key, height);
		return Math.abs(previous - height) > 0.5;
	}

	/** Forget the keys no longer in the list, so the map follows the list. */
	keep(keys: readonly unknown[]): void {
		if (this.#heights.size <= keys.length) return;
		const live = new Set(keys);
		for (const key of this.#heights.keys()) {
			if (live.has(key)) continue;
			this.#heights.delete(key);
			this.#stale = true;
		}
	}

	#offsetsFor(keys: readonly unknown[]): Float64Array {
		if (!this.#stale && this.#offsetsOf === keys) return this.#offsets;
		const offsets = new Float64Array(keys.length + 1);
		const { estimate } = this.#lazy;
		const measured = this.#heights.size > 0;
		for (let i = 0; i < keys.length; i++) {
			offsets[i + 1] =
				(offsets[i] ?? 0) + (measured ? this.heightOf(keys[i]) : estimate);
		}
		this.#offsets = offsets;
		this.#offsetsOf = keys;
		this.#stale = false;
		return offsets;
	}

	/** Rows [start, end) and the spacers around them. */
	spacers(keys: readonly unknown[], start: number, end: number): LazyWindow {
		if (this.#heights.size === 0) {
			// Nothing measured yet (the first window, on the server too).
			const { estimate } = this.#lazy;
			return {
				start,
				end,
				before: start * estimate,
				after: (keys.length - end) * estimate,
			};
		}
		const offsets = this.#offsetsFor(keys);
		const total = offsets[keys.length] ?? 0;
		return {
			start,
			end,
			before: offsets[start] ?? 0,
			after: total - (offsets[end] ?? total),
		};
	}

	/** The rows a viewport needs, `overscan` included on each side. */
	window(keys: readonly unknown[], view: LazyView): LazyWindow {
		const count = keys.length;
		const { overscan } = this.#lazy;
		const offsets = this.#offsetsFor(keys);
		const total = offsets[count] ?? 0;
		if (view.kind === "end") {
			// The last rows that cover the viewport and the margin.
			const reach = total - (view.height + overscan);
			const start = Math.max(0, firstAbove(offsets, reach) - 1);
			return this.spacers(keys, Math.min(start, count), count);
		}
		// The first row ending below the window's top, the first starting at
		// or past its bottom.
		const above = firstAbove(offsets, view.from - overscan);
		let start = above > count ? count : Math.max(above, 1) - 1;
		const end = Math.min(firstAtLeast(offsets, view.to + overscan), count);
		if (start > end) start = end;
		return this.spacers(keys, start, end);
	}
}
