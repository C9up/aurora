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
	/**
	 * What this render pass's ids are namespaced under, or empty for none.
	 *
	 * A counter alone is not enough once a page has more than one hydration
	 * root, and a page with a live component HAS more than one: `renderPage`
	 * builds the page root and `liveClient` hydrates its own container. Both
	 * used to restart the same counter, so the second root minted the ids the
	 * first was already using. Two elements then shared an id — `byId` answered
	 * with whichever came first in the document, and `aria-controls` pointed at
	 * a node in the other root.
	 *
	 * The namespace has to be the same on both sides for an id to survive
	 * hydration, so it is never invented locally: the page root uses its own
	 * element id (which the hydrate bootstrap reads back off the container), and
	 * a live component uses its session id, which the mount response already
	 * carries to the client.
	 */
	scope: string;
}

const fallback: Counter = { value: 0, scope: "" };
let readCounter: (() => Counter | undefined) | undefined;
/** Set while a scoped pass is running; takes precedence over everything. */
let override: Counter | undefined;

/**
 * @internal Point the ids at a per-render cell. Called by the server; the
 * browser leaves it alone and keeps the module-level one.
 */
export function setIdCounterReader(reader: () => Counter | undefined): void {
	readCounter = reader;
}

/** @internal A fresh cell for one render pass, namespaced under `scope`. */
export function createIdCounter(scope = ""): Counter {
	return { value: 0, scope };
}

function cell(): Counter {
	return override ?? readCounter?.() ?? fallback;
}

/** Mint an id unique within this render pass, and within its root. */
export function uid(prefix = "aurora"): string {
	const current = cell();
	current.value += 1;
	const name = `${prefix}-${current.value}`;
	return current.scope === "" ? name : `${current.scope}-${name}`;
}

/**
 * Run `work` against a fresh counter namespaced under `scope`, then put back
 * whatever was there.
 *
 * This is what `hydrate` uses, and it replaced a `resetIds()` call because
 * resetting is the collision: a shared counter that every root restarts hands
 * the same ids to each of them. A pass that borrows its own cell cannot
 * interfere with another root whatever order they run in.
 *
 * Synchronous on purpose — no `AsyncHooks`, so it holds in a browser. The ids a
 * component mints are minted while its template is built, which is inside this
 * call; nothing mints one later.
 */
export function withIdScope<T>(scope: string, work: () => T): T {
	const previous = override;
	override = createIdCounter(scope);
	try {
		return work();
	} finally {
		override = previous;
	}
}

/**
 * Restart the sequence, optionally under a namespace. For an application that
 * calls `renderToString` itself and will hydrate the result: pass the same
 * `scope` to both sides, or let `hydrate` take it from the container's id.
 */
export function resetIds(scope = ""): void {
	const current = cell();
	current.value = 0;
	current.scope = scope;
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
