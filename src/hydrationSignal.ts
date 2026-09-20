/**
 * "The client has taken over this markup."
 *
 * Read from the runtimes that solve the same problem — `@adonisjs/inertia`
 * (`dispatchEvent(new CustomEvent(\`inertia:${name}\`))`), Hotwire's
 * `turbo:load` / `turbo:frame-load`, htmx's `htmx:load` — three conclusions,
 * none of them obvious:
 *
 * 1. It is a DOM event, not a promise. None of them exposes `await ready()`,
 *    because a promise is consumed once while the client becomes ready again
 *    after every navigation. Turbo re-fires `turbo:load` on each visit.
 * 2. Granularity matters as much as the event. Turbo has `turbo:frame-load`
 *    beside `turbo:load`; htmx fires per swapped fragment. aurora hydrates
 *    islands, so a page-level signal alone is either too early or too late.
 * 3. The name states the phase, never the intent — `load`, `settle`,
 *    `navigate`, never `ready`. "Ready" has no stable definition; "this root
 *    finished hydrating" has one.
 *
 * Where this goes further, deliberately: an event alone carries a race of its
 * own. Subscribe after it fired and you wait forever — which is precisely the
 * class of bug the signal exists to remove, reintroduced one layer up. The DOM
 * answers that with `document.readyState` beside `DOMContentLoaded`, so this
 * does the same: {@link hydrationState} is readable at any time and
 * {@link whenHydrated} resolves immediately when the work is already done.
 */

/** Phase of the page's hydration, readable at any moment. */
export type HydrationState = "pending" | "hydrating" | "hydrated";

/** What `aurora:hydrate` and `aurora:load` carry. */
export interface HydrationDetail {
	/** The root that was hydrated. Absent on the page-level event. */
	container?: Element;
	/**
	 * What went wrong, when something did.
	 *
	 * The event fires either way on purpose: a signal withheld on failure turns
	 * a race into a silent hang, and the caller waiting for it has no way to
	 * tell the two apart.
	 */
	error?: unknown;
}

let state: HydrationState = "pending";
let pending = 0;
let settled: Promise<void> | undefined;
let resolveSettled: (() => void) | undefined;
const errors: unknown[] = [];

/** The current phase. `"pending"` until the first root starts hydrating. */
export function hydrationState(): HydrationState {
	return state;
}

/** Every error collected while hydrating, in order. Empty when all went well. */
export function hydrationErrors(): readonly unknown[] {
	return errors;
}

/**
 * Resolves when the page has finished hydrating — immediately if it already
 * has, which is what an event listener cannot promise.
 *
 * Never rejects: a failed root still settles the page, and the reason is in
 * {@link hydrationErrors}. A helper that rejected would make the common
 * `await whenHydrated()` in a test throw on a page that is, in fact, ready.
 */
export function whenHydrated(): Promise<void> {
	if (state === "hydrated" || state === "pending") return Promise.resolve();
	settled ??= new Promise<void>((resolve) => {
		resolveSettled = resolve;
	});
	return settled;
}

function dispatch(type: string, target: EventTarget, detail: HydrationDetail) {
	// `typeof` rather than a bundler flag: this module is on the client barrel
	// and still gets imported in SSR, where neither exists.
	if (typeof CustomEvent === "undefined") return;
	target.dispatchEvent(
		new CustomEvent<HydrationDetail>(type, {
			detail,
			bubbles: true,
			composed: true,
		}),
	);
}

/** @internal Called by `hydrate()` before it adopts a root. */
export function beginHydration(): void {
	if (state === "hydrated") {
		// A second wave — a client-side navigation. Start over, as Turbo does.
		state = "pending";
		errors.length = 0;
		settled = undefined;
		resolveSettled = undefined;
	}
	state = "hydrating";
	pending += 1;
}

/** @internal Called by `hydrate()` once a root is adopted, or has failed. */
export function endHydration(container: Element, error?: unknown): void {
	if (error !== undefined) errors.push(error);
	dispatch("aurora:hydrate", container, { container, error });
	pending -= 1;
	if (pending > 0) return;

	// One turn of the event loop before declaring the page done: roots are
	// hydrated in a loop, and settling between two of them would announce a
	// page that is still filling in.
	queueMicrotask(() => {
		if (pending !== 0 || state !== "hydrating") return;
		state = "hydrated";
		if (typeof document !== "undefined") {
			dispatch("aurora:load", document, {});
		}
		resolveSettled?.();
	});
}
