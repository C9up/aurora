/**
 * Keyed list rendering.
 *
 * A reactive slot that returns an array rebuilds every row whenever the array
 * changes — a list re-read every few seconds lost its open menus, its focus and
 * its hover each time, even when nothing in it had moved. `each` renders a row
 * once per KEY instead, as Svelte's keyed `{#each}` does: a row whose key stays
 * keeps its nodes and its effects, moves when the order changes, and sees a new
 * element through the accessor it was given; a key that leaves is disposed.
 *
 *     html`<ul>${each(rows, (row) => row.id, (row) => html`<li>${() => row().name}</li>`)}</ul>`
 *
 * The value is still a plain accessor, so the server and any reader that does
 * not know the brand render it as the array it returns.
 *
 * Aurora has no upstream to match here; the shape is Svelte's keyed each — a
 * key function and a row renderer — with the row's element and index handed
 * over as accessors, because a row is built once and never re-rendered.
 */

import { captureContext } from "./component.js";
import { AuroraError } from "./errors.js";
import { html } from "./html.js";
import { firstWindow, type LazyList } from "./lazy.js";
import { type ReadSignal, type Signal, signal } from "./reactive.js";

/**
 * What a list is built from: the array itself, or an accessor that returns it.
 *
 * The signal types are named although a signal is an accessor: inferring `T`
 * from an overloaded call signature reads its last overload, a signal's setter,
 * and `T` came out `unknown`.
 */
export type EachItems<T> =
	| readonly T[]
	| Signal<readonly T[]>
	| ReadSignal<readonly T[]>
	| (() => readonly T[]);

/** @internal What the renderer needs to keep a list's rows by key. */
export interface EachList<T = unknown> {
	items: EachItems<T>;
	key: (item: T, index: number) => unknown;
	render: (item: ReadSignal<T>, index: ReadSignal<number>) => unknown;
	/** Runs a row's `render` with the providers in reach where the list was written. */
	run: <R>(fn: () => R) => R;
	/** Set for a lazy list: only the rows in view exist. */
	lazy?: LazyList;
}

/**
 * A lazy list's settings (Compose's LazyColumn): only the rows intersecting
 * the scroll viewport, plus `overscan` on each side, are built; the others are
 * stood in for by two spacers sized from the rows' measured heights, or
 * `estimate` for a row never shown. Lengths are CSS pixels on the web, dp on
 * a phone.
 */
export interface LazyOptions {
	/** The height assumed for a row not measured yet. Default 48. */
	estimate?: number;
	/** How far beyond the viewport rows are built. Default 600. */
	overscan?: number;
	/**
	 * `"end"` starts at the last rows and stays at the end as rows arrive while
	 * it is there: a conversation. Default `"start"`.
	 */
	from?: "start" | "end";
}

/** What {@link each} takes after the row renderer. */
export interface EachOptions {
	/** Build only the rows in view: `true` for the defaults, or its settings. */
	lazy?: boolean | LazyOptions;
}

function lazyList(options: EachOptions | undefined): LazyList | undefined {
	const lazy = options?.lazy;
	if (lazy === undefined || lazy === false) return undefined;
	const settings = lazy === true ? {} : lazy;
	const estimate = settings.estimate ?? 48;
	const overscan = settings.overscan ?? 600;
	if (!(Number.isFinite(estimate) && estimate > 0)) {
		throw new AuroraError(
			"E_AURORA_INVALID_LAZY",
			`[aurora] each(): lazy.estimate must be a positive length, got ${String(estimate)}`,
		);
	}
	if (!(Number.isFinite(overscan) && overscan >= 0)) {
		throw new AuroraError(
			"E_AURORA_INVALID_LAZY",
			`[aurora] each(): lazy.overscan must be zero or a positive length, got ${String(overscan)}`,
		);
	}
	return { estimate, overscan, from: settings.from ?? "start" };
}

/**
 * A lazy list's spacer: what stands in for the rows not built. Hidden when
 * empty, so a gap-separated container gets no gap for it.
 */
function spacer(side: "before" | "after", height: number): unknown {
	return html`<div data-aurora-lazy=${side} aria-hidden="true" style=${
		height > 0 ? `height:${height}px;overflow-anchor:none` : "display:none"
	}></div>`;
}

const EACH_LIST: unique symbol = Symbol.for("aurora:each");

/** Brand of the value {@link each} returns, so a type can name it. */
export const EACH_BRAND: unique symbol = Symbol.for("aurora:each-brand");

/**
 * A keyed list, as {@link each} returns it: an accessor for its rows, branded
 * so the renderer keeps them by key and a content type can accept it.
 */
export interface Each {
	(): unknown[];
	readonly [EACH_BRAND]: true;
}

/**
 * Render `items` one row per key.
 *
 * `key` names a row — an id, never the index, or every insertion renumbers the
 * rows after it. `render` is called once per key, with accessors: `item()` is
 * the row's current element and `index()` its current position, and both
 * change without the row being rebuilt. Read them in an accessor
 * (`${() => item().name}`) for the part that follows them. Two elements with
 * the same key throw `E_AURORA_DUPLICATE_KEY` — they would have to share one
 * row.
 *
 * `{ lazy }` builds only the rows in view (see {@link LazyOptions}): a list of
 * thousands of rows costs what the screen shows. It lays out in a block or
 * flex container (not a table: its spacers are `div`s) and scrolls with its
 * nearest scrolling ancestor, or the page.
 */
export function each<T>(
	items: EachItems<T>,
	key: (item: T, index: number) => unknown,
	render: (item: ReadSignal<T>, index: ReadSignal<number>) => unknown,
	options?: EachOptions,
): Each {
	const lazy = lazyList(options);
	const list: EachList<T> = { items, key, render, run: captureContext() };
	if (lazy) list.lazy = lazy;
	// What a reader that does not keep rows by key shows: the server, mainly.
	// A lazy list gives its first window between its spacers, the one the
	// client starts from when it adopts the server's rows.
	const accessor = (): unknown[] =>
		list.run(() => {
			const all = readEachItems(list.items);
			if (!lazy) {
				return all.map((item, index) =>
					list.render(constant(item), constant(index)),
				);
			}
			const [start, end] = firstWindow(all.length, lazy);
			return [
				spacer("before", start * lazy.estimate),
				...all
					.slice(start, end)
					.map((item, i) => list.render(constant(item), constant(start + i))),
				spacer("after", (all.length - end) * lazy.estimate),
			];
		});
	Reflect.set(accessor, EACH_LIST, list);
	const brand: { readonly [EACH_BRAND]: true } = { [EACH_BRAND]: true };
	return Object.assign(accessor, brand);
}

/** Whether `value` is a keyed list made by {@link each}. */
export function isEach(value: unknown): value is Each {
	return readEach(value) !== undefined;
}

/** @internal The list behind a slot value made by {@link each}, if it is one. */
export function readEach(value: unknown): EachList | undefined {
	if (typeof value !== "function") return undefined;
	const list: unknown = Reflect.get(value, EACH_LIST);
	return isEachList(list) ? list : undefined;
}

/** @internal The elements a list holds now, read where the caller tracks them. */
export function readEachItems<T>(items: EachItems<T>): readonly T[] {
	return typeof items === "function" ? items() : items;
}

function isEachList(value: unknown): value is EachList {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "key") === "function" &&
		typeof Reflect.get(value, "render") === "function" &&
		typeof Reflect.get(value, "run") === "function"
	);
}

/** An accessor that never changes, for a row rendered once. */
function constant<T>(value: T): ReadSignal<T> {
	return signal(value);
}
