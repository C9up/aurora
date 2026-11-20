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

/** Row heights by key, measured where shown, estimated elsewhere. */
export class LazyLayout {
	readonly #lazy: LazyList;
	readonly #heights = new Map<unknown, number>();

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
		this.#heights.set(key, height);
		return Math.abs(previous - height) > 0.5;
	}

	/** Forget the keys no longer in the list, so the map follows the list. */
	keep(keys: readonly unknown[]): void {
		if (this.#heights.size <= keys.length) return;
		const live = new Set(keys);
		for (const key of this.#heights.keys())
			if (!live.has(key)) this.#heights.delete(key);
	}

	/** Rows [start, end) and the spacers around them. */
	spacers(keys: readonly unknown[], start: number, end: number): LazyWindow {
		let before = 0;
		let after = 0;
		for (let i = 0; i < keys.length; i++) {
			if (i < start) before += this.heightOf(keys[i]);
			else if (i >= end) after += this.heightOf(keys[i]);
		}
		return { start, end, before, after };
	}

	/** The rows a viewport needs, `overscan` included on each side. */
	window(keys: readonly unknown[], view: LazyView): LazyWindow {
		const count = keys.length;
		const { overscan } = this.#lazy;
		if (view.kind === "end") {
			// From the last row up, until the viewport and the margin are covered.
			let covered = 0;
			let start = count;
			while (start > 0 && covered < view.height + overscan) {
				start--;
				covered += this.heightOf(keys[start]);
			}
			return this.spacers(keys, start, count);
		}
		const low = view.from - overscan;
		const high = view.to + overscan;
		let y = 0;
		let start = count;
		let end = count;
		for (let i = 0; i < count; i++) {
			const h = this.heightOf(keys[i]);
			if (start === count && y + h > low) start = i;
			if (y >= high) {
				end = i;
				break;
			}
			y += h;
		}
		if (start > end) start = end;
		return this.spacers(keys, start, end);
	}
}
