/**
 * Stable element ids, shared by the server pass and the client pass.
 *
 * ARIA wiring needs them — a trigger's `aria-controls` has to name the id its
 * content actually carries — and so does element lookup: aurora templates have
 * no `ref` directive, so a component that must measure, focus or anchor a node
 * finds it by id inside `onMount`.
 *
 * The counter is monotonic, so the sequence depends only on the order
 * components are constructed in. That order is identical on the server and in
 * the browser for the same tree, which is what makes an id survive hydration —
 * the property React's `useId` relies on.
 *
 * It only holds if both passes START FROM THE SAME PLACE, and that is the bug
 * this module exists to close. A server process is long-lived: without a reset
 * its counter climbs across requests, so the second page it serves ships
 * `trigger-14` while the browser, starting fresh, looks for `trigger-1`. Every
 * id-based lookup then answers `null` — and it answers `null` silently, so the
 * symptom is a tooltip that never opens, an anchor that never positions, a
 * trigger whose `aria-controls` points at nothing, on a page where every
 * binding otherwise works.
 *
 * `renderPage` and `hydrate` each reset before they build, so an application
 * using either gets matching sequences for free. One that calls
 * `renderToString` itself resets before it, the way `renderPage` does.
 */

/**
 * The counter, in a cell so it can be swapped per render.
 *
 * A module-level number is what a single-page browser needs, and exactly what
 * a SERVER must not have: `renderPage` resets, then awaits — resolving the
 * page module, gathering shared props, calling the component. Two requests
 * overlapping across any of those awaits share the counter, and one response
 * ships `trigger-2` while its browser hydrates from `trigger-1`. Caught by an
 * external audit, not by the sequential tests.
 *
 * So the cell is looked up through a reader the server installs, backed by its
 * per-request AsyncLocalStorage. Nothing here imports `node:async_hooks` —
 * this module is in the browser barrel.
 */
interface Counter {
	value: number;
}

const fallback: Counter = { value: 0 };
let readCounter: (() => Counter | undefined) | undefined;

/**
 * @internal Point the ids at a per-render cell. Called by the server; the
 * browser leaves it alone and keeps the module-level one.
 */
export function setIdCounterReader(reader: () => Counter | undefined): void {
	readCounter = reader;
}

/** @internal A fresh cell for one render pass. */
export function createIdCounter(): Counter {
	return { value: 0 };
}

function cell(): Counter {
	return readCounter?.() ?? fallback;
}

/** Mint an id unique within this render pass. */
export function uid(prefix = "aurora"): string {
	const current = cell();
	current.value += 1;
	return `${prefix}-${current.value}`;
}

/**
 * Restart the sequence. Called by `renderPage` and by `hydrate`; call it
 * yourself before a `renderToString` whose markup will be hydrated.
 */
export function resetIds(): void {
	cell().value = 0;
}

/**
 * Look an element up by the id a component minted for it.
 *
 * Answers `null` off the DOM (SSR) or before mount rather than throwing, so
 * the same code runs in both environments.
 */
export function byId(id: string): HTMLElement | null {
	if (typeof document === "undefined") return null;
	return document.getElementById(id);
}
