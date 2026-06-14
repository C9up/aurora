/**
 * Reactive core — signals + effects with auto-tracking.
 *
 * No proxies, no VDOM. A `signal<T>()` is a single read/write function that
 * registers itself in the currently-running observer's dependency set when
 * read, and notifies every dependent observer when written.
 *
 * Effects run their callback once eagerly, capture the signals they read,
 * and re-run whenever any of those signals fires. Effects can return a
 * cleanup function that runs before the next re-execution and at disposal.
 */

import type { EffectCallback } from "./types.js";

/** Reader-only view of a signal. Returned by `memo()`. */
export interface ReadSignal<T> {
	(): T;
	readonly [SIGNAL_BRAND]: true;
}

/** Read-write signal — call with no args to read, with one arg to write. */
export interface Signal<T> {
	(): T;
	(next: T): void;
	(updater: (prev: T) => T): void;
	readonly [SIGNAL_BRAND]: true;
}

/**
 * Brand symbol so consumers can distinguish a signal from a plain function
 * without instanceof. Exposed only via the `isSignal` guard — never call
 * sites need to import this directly.
 */
export const SIGNAL_BRAND: unique symbol = Symbol.for("aurora:signal");

/** An effect computation that re-runs when any tracked signal changes. */
interface Effect {
	run(): void;
	dispose(): void;
	readonly dependencies: Set<SignalNode<unknown>>;
	readonly cleanups: Array<() => void>;
	disposed: boolean;
}

/** Internal node shared by every signal — the dependency-tracking primitive. */
interface SignalNode<T> {
	value: T;
	observers: Set<Effect>;
	/**
	 * Custom equality. `Object.is` is the default — passing a custom
	 * comparator lets callers store reference-equal values (arrays, maps)
	 * without spurious recomputation.
	 */
	equals: (a: T, b: T) => boolean;
}

// `undefined` entries are untrack() sentinels — a read while one is on
// top sees "no active observer" and registers no dependency.
const observerStack: Array<Effect | undefined> = [];
let batchDepth = 0;
const pendingNotifications = new Set<Effect>();

function activeObserver(): Effect | undefined {
	return observerStack[observerStack.length - 1];
}

/**
 * Ambient disposal owner. A non-reactive scope (e.g. a component's setup
 * run) registers an array here so effects/memos created during its
 * execution push their disposer into it and are torn down when the scope
 * ends. `undefined` at top level — no scope, no auto-disposal.
 */
let currentOwner: Array<() => void> | undefined;

/**
 * @internal Swap the ambient owner, returning the previous one so the
 * caller can restore it. `component()` uses this to own the effects and
 * memos a setup function creates, so they dispose at unmount instead of
 * keeping their signal subscriptions alive forever.
 */
export function setOwner(
	owner: Array<() => void> | undefined,
): Array<() => void> | undefined {
	const prev = currentOwner;
	currentOwner = owner;
	return prev;
}

/**
 * Create a writable signal seeded with `initial`. Reads register the
 * current observer; writes notify every observer that previously read.
 *
 * Optional `{ equals }` swaps the default `Object.is` check — return
 * `true` to skip notifying observers (the new value is "the same").
 */
export function signal<T>(
	initial: T,
	options?: { equals?: (a: T, b: T) => boolean },
): Signal<T> {
	const node: SignalNode<T> = {
		value: initial,
		observers: new Set(),
		equals: options?.equals ?? Object.is,
	};

	function accessor(...args: [] | [T] | [(prev: T) => T]): T | undefined {
		if (args.length === 0) {
			const obs = activeObserver();
			if (obs) {
				node.observers.add(obs);
				obs.dependencies.add(node as SignalNode<unknown>);
			}
			return node.value;
		}
		const arg = args[0];
		const next =
			typeof arg === "function"
				? (arg as (prev: T) => T)(node.value)
				: (arg as T);
		if (node.equals(node.value, next)) return;
		node.value = next;
		// Snapshot observers before iteration — an effect's run() may
		// dispose itself (or peers) and mutate the live Set during the
		// loop, which would skip notifications under for…of semantics.
		const toNotify = [...node.observers];
		if (batchDepth > 0) {
			for (const eff of toNotify) pendingNotifications.add(eff);
			return;
		}
		for (const eff of toNotify) {
			if (!eff.disposed) eff.run();
		}
	}

	(accessor as unknown as { [SIGNAL_BRAND]: true })[SIGNAL_BRAND] = true;
	signalNodes.set(accessor, node);
	return accessor as Signal<T>;
}

/**
 * Test-only registry mapping a signal accessor to its backing node, so
 * `observerCount` can assert the observer Set doesn't leak. A WeakMap
 * keeps it off the public accessor surface and never retains a disposed
 * signal.
 */
const signalNodes = new WeakMap<
	object,
	{ observers: { readonly size: number } }
>();

/**
 * @internal Observer-count test seam for the untrack-leak invariant: a
 * read inside `untrack()` must NOT add an entry to a signal's observer
 * Set. Returns -1 for a value that isn't a tracked signal.
 */
export function observerCount(sig: object): number {
	const node = signalNodes.get(sig);
	return node ? node.observers.size : -1;
}

/** Runtime guard — distinguishes a signal accessor from any other callable. */
export function isSignal<T = unknown>(value: unknown): value is Signal<T> {
	return (
		typeof value === "function" &&
		(value as { [SIGNAL_BRAND]?: boolean })[SIGNAL_BRAND] === true
	);
}

/**
 * Run `fn` immediately and every time a signal it reads changes. Returns a
 * dispose function — call it to stop the effect and run any pending
 * cleanup.
 *
 * Inside `fn`, return another function to register cleanup that runs
 * before the next execution AND at disposal. Multiple cleanups can also
 * be registered via `onCleanup()`.
 */
export function effect(fn: EffectCallback): () => void {
	const eff: Effect = {
		dependencies: new Set(),
		cleanups: [],
		disposed: false,
		run() {
			if (this.disposed) return;
			runCleanups(this);
			detach(this);
			observerStack.push(this);
			try {
				const teardown = fn();
				if (typeof teardown === "function") this.cleanups.push(teardown);
			} finally {
				observerStack.pop();
			}
		},
		dispose() {
			if (this.disposed) return;
			this.disposed = true;
			runCleanups(this);
			detach(this);
		},
	};
	eff.run();
	const dispose = () => eff.dispose();
	// Register with the ambient owner (e.g. a component's setup scope) so the
	// effect is torn down when that scope ends. `memo()` builds on this — its
	// internal recompute effect inherits the same ownership, which is what
	// stops a memo created in component setup from leaking after unmount.
	currentOwner?.push(dispose);
	return dispose;
}

/**
 * Register a cleanup callback against the currently-running effect.
 * No-op when called outside an effect — same contract as Solid's
 * `onCleanup`, more permissive than React's hook-only access.
 */
export function onCleanup(fn: () => void): void {
	const obs = activeObserver();
	if (obs) obs.cleanups.push(fn);
}

/**
 * Defer notifications until `fn` returns. Multiple writes to the same
 * signal coalesce into a single observer re-run, and writes across
 * signals re-run each affected observer at most once.
 */
export function batch<T>(fn: () => T): T {
	batchDepth++;
	try {
		return fn();
	} finally {
		batchDepth--;
		if (batchDepth === 0) {
			const toRun = [...pendingNotifications];
			pendingNotifications.clear();
			for (const eff of toRun) {
				if (!eff.disposed) eff.run();
			}
		}
	}
}

/**
 * Read signals inside `fn` without registering them as dependencies of
 * the current observer. Useful when an effect needs the current value of
 * a signal but should not re-run when it changes.
 */
export function untrack<T>(fn: () => T): T {
	// Push an `undefined` sentinel rather than a dummy Effect. A dummy
	// gets `add()`-ed into every signal's `observers` Set on read and is
	// never detached, leaking dead entries that grow each write. With
	// `undefined` on top, `activeObserver()` returns undefined and reads
	// register nothing — the actual "untracked" semantics.
	observerStack.push(undefined);
	try {
		return fn();
	} finally {
		observerStack.pop();
	}
}

/**
 * Derived read-only signal — `fn` re-runs when any signal it reads
 * changes, and the latest return value is cached + handed out via the
 * returned accessor. Cleanups inside `fn` (via `onCleanup`) run on every
 * recomputation.
 */
export function memo<T>(fn: () => T): ReadSignal<T> {
	const internal = signal<T | undefined>(undefined);
	effect(() => {
		internal(fn());
	});
	const reader = (() => internal() as T) as ReadSignal<T>;
	(reader as { [SIGNAL_BRAND]: true })[SIGNAL_BRAND] = true;
	return reader;
}

function runCleanups(eff: Effect): void {
	if (eff.cleanups.length === 0) return;
	const queued = eff.cleanups.splice(0, eff.cleanups.length);
	for (const cleanup of queued) {
		try {
			cleanup();
		} catch {
			/* swallow — cleanup errors must not block sibling cleanups */
		}
	}
}

function detach(eff: Effect): void {
	for (const dep of eff.dependencies) dep.observers.delete(eff);
	eff.dependencies.clear();
}
