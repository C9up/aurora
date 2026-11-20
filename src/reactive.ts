/**
 * Reactive core — signals, memos and effects with auto-tracking.
 *
 * No proxies, no VDOM. A `signal<T>()` is a single read/write function that
 * registers itself in the currently-running observer's dependency set when
 * read, and notifies every dependent observer when written.
 *
 * Effects run their callback once eagerly, capture the signals they read,
 * and re-run whenever any of those signals changes. Effects can return a
 * cleanup function that runs before the next re-execution and at disposal.
 *
 * A write marks what depends on it instead of running it there and then:
 * the effects it reaches directly are dirty, those it reaches through a memo
 * only need a check. The marked effects then run once each, parents before
 * the effects they created, and a memo is brought up to date when it is read.
 * Running each observer from inside the write ran an effect once per path to
 * the signal — once for the signal, again for a memo of it — and the first
 * time against the memo's stale value.
 *
 * An effect or a memo owns what its run creates: the effects, memos and
 * components made while it runs are disposed when it runs again or ends.
 */

import { AuroraError } from "./errors.js";
import { probe } from "./rerenders.js";
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

/** Up to date. */
const CLEAN = 0;
/** A memo it read may have changed: check those before deciding to run. */
const CHECK = 1;
/** Something it read changed: run it. */
const DIRTY = 2;
type Freshness = typeof CLEAN | typeof CHECK | typeof DIRTY;

/**
 * What a computation keeps of something it read: the observers to leave when
 * it re-runs or is disposed, and how to bring it up to date before deciding
 * whether it changed — a memo recomputes there, a signal is always current.
 */
interface Dependency {
	readonly observers: Set<Computation>;
	refresh(): void;
}

/** An effect or a memo: something that runs, reads, and runs again. */
interface Computation {
	readonly kind: "effect" | "memo";
	/** What its last run read. */
	readonly sources: Set<Dependency>;
	/** Cleanups registered by its last run, run before the next and at disposal. */
	readonly cleanups: Array<() => void>;
	/** Disposers of what its last run created, ended before the next run. */
	readonly owned: Array<() => void>;
	/**
	 * How many computations it was created inside. A flush runs the shallower
	 * first, so a parent that is about to dispose its child runs before it,
	 * and the child never runs against a state its parent is removing.
	 */
	readonly depth: number;
	/** A memo's readers. Empty for an effect, which nothing reads. */
	readonly observers: Set<Computation>;
	state: Freshness;
	disposed: boolean;
	/** Whether it ran at least once, so a later run is a re-run. */
	ran: boolean;
	/** The body: an effect's callback, a memo's recomputation. */
	execute(): void;
}

// `undefined` entries are untrack() sentinels — a read while one is on
// top sees "no active observer" and registers no dependency.
const observerStack: Array<Computation | undefined> = [];

/** The computation running now, tracked or not: it owns what is created. */
let running: Computation | undefined;

let batchDepth = 0;
let flushing = false;
/** Effects marked since the last flush, in the order they were marked. */
let queue: Computation[] = [];

/**
 * Past this many runs in one flush, effects are re-running each other in a
 * loop that will not settle. Generous: a real page settles in a few hundred.
 */
const MAX_RUNS_PER_FLUSH = 100_000;

function activeObserver(): Computation | undefined {
	return observerStack[observerStack.length - 1];
}

/**
 * Ambient disposal owner. A non-reactive scope (e.g. a component's setup
 * run) registers an array here so effects/memos created during its
 * execution push their disposer into it and are torn down when the scope
 * ends. A computation's run sets its own; `undefined` at top level — no
 * scope, no auto-disposal.
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

/** Register `dep` as read by the observer running now, if one tracks. */
function track(dep: Dependency): void {
	const obs = activeObserver();
	if (obs === undefined || obs.disposed) return;
	dep.observers.add(obs);
	obs.sources.add(dep);
}

/**
 * Mark `c` at least `state`. An effect leaving CLEAN joins the queue; a memo
 * leaving CLEAN has its readers checked, since its value may change.
 */
function mark(c: Computation, state: Freshness): void {
	if (c.disposed || c.state >= state) return;
	const wasClean = c.state === CLEAN;
	c.state = state;
	if (!wasClean) return;
	if (c.kind === "effect") queue.push(c);
	else for (const reader of c.observers) mark(reader, CHECK);
}

/** Bring `c` up to date: run it if something it read changed. */
function update(c: Computation): void {
	if (c.disposed) return;
	if (c.state === CHECK) {
		for (const source of c.sources) {
			source.refresh();
			// A memo that changed marked its readers dirty, this one included.
			if (isDirty(c)) break;
		}
	}
	if (isDirty(c)) run(c);
	else c.state = CLEAN;
}

/**
 * Read through a call, because refreshing a source changes `c.state` behind
 * the compiler's back: narrowed to CHECK above, it would call DIRTY impossible.
 */
function isDirty(c: Computation): boolean {
	return c.state === DIRTY;
}

/** Run `c`'s body, tracking what it reads and owning what it creates. */
function run(c: Computation): void {
	disposeOwned(c);
	runCleanups(c);
	detach(c);
	c.state = CLEAN;
	if (c.ran) probe.emit?.({ kind: c.kind });
	c.ran = true;
	observerStack.push(c);
	const prevOwner = setOwner(c.owned);
	const prevRunning = running;
	running = c;
	try {
		c.execute();
	} finally {
		running = prevRunning;
		setOwner(prevOwner);
		observerStack.pop();
	}
}

/** Run the marked effects until none is left, shallowest first. */
function flush(): void {
	flushing = true;
	let runs = 0;
	let failure: { error: unknown } | undefined;
	try {
		while (queue.length > 0) {
			const round = queue;
			queue = [];
			// Stable: effects of one depth keep the order they were marked in.
			round.sort((a, b) => a.depth - b.depth);
			for (const c of round) {
				if (c.disposed || c.state === CLEAN) continue;
				if (++runs > MAX_RUNS_PER_FLUSH) {
					for (const left of [...round, ...queue]) left.state = CLEAN;
					queue = [];
					throw new AuroraError(
						"E_AURORA_REACTIVE_CYCLE",
						`[aurora] effects re-ran more than ${MAX_RUNS_PER_FLUSH} times in one update — an effect writes a signal that it, or an effect it triggers, reads`,
					);
				}
				try {
					update(c);
				} catch (error) {
					// One broken effect must not freeze the rest of the page: the others
					// still run, and the first error is rethrown once they have.
					c.state = CLEAN;
					failure ??= { error };
				}
			}
		}
	} finally {
		flushing = false;
	}
	if (failure !== undefined) throw failure.error;
}

/** Flush now, unless a batch or a flush already in progress will. */
function flushIfIdle(): void {
	if (batchDepth === 0 && !flushing) flush();
}

function createComputation(
	kind: "effect" | "memo",
	execute: (self: Computation) => void,
): Computation {
	const c: Computation = {
		kind,
		sources: new Set(),
		cleanups: [],
		owned: [],
		depth: running === undefined ? 0 : running.depth + 1,
		observers: new Set(),
		state: CLEAN,
		disposed: false,
		ran: false,
		execute: () => execute(c),
	};
	return c;
}

function dispose(c: Computation): void {
	if (c.disposed) return;
	c.disposed = true;
	disposeOwned(c);
	runCleanups(c);
	detach(c);
	c.state = CLEAN;
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
	const equals = options?.equals ?? Object.is;
	let value = initial;
	const node: Dependency = {
		observers: new Set(),
		refresh() {},
	};

	function accessor(...args: [] | [T] | [(prev: T) => T]): T | undefined {
		if (args.length === 0) {
			track(node);
			return value;
		}
		const arg = args[0];
		const next = isUpdater(arg) ? arg(value) : arg;
		if (equals(value, next)) return;
		value = next;
		for (const observer of node.observers) mark(observer, DIRTY);
		flushIfIdle();
	}

	// The brand is stamped through Reflect: the accessor is a function, and
	// saying it is a branded object to write one property would be a lie the
	// rest of the file then has to work around.
	Reflect.set(accessor, SIGNAL_BRAND, true);
	signalNodes.set(accessor, node);
	// NAMED CAST: one implementation behind three overloads. TypeScript cannot
	// check an overloaded call signature against a single implementation, and
	// the brand it requires was stamped just above.
	return accessor as Signal<T>;
}

/**
 * Is a write's argument an updater rather than the next value? A function is
 * always read as an updater, which is why a signal holding a function is
 * written through `sig(() => fn)`.
 */
function isUpdater<T>(arg: T | ((prev: T) => T)): arg is (prev: T) => T {
	return typeof arg === "function";
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

/**
 * @internal A slot value as the renderers read it: a signal or a reactive
 * expression is called, anything else is the value itself.
 */
export function readValue(value: unknown): unknown {
	if (typeof value !== "function") return value;
	const read: unknown = Reflect.apply(value, undefined, []);
	return read;
}

/** Runtime guard — distinguishes a signal accessor from any other callable. */
export function isSignal<T = unknown>(value: unknown): value is Signal<T> {
	return (
		typeof value === "function" && Reflect.get(value, SIGNAL_BRAND) === true
	);
}

/**
 * Run `fn` immediately and every time a signal it reads changes. Returns a
 * dispose function — call it to stop the effect and run any pending
 * cleanup.
 *
 * Inside `fn`, return another function to register cleanup that runs
 * before the next execution AND at disposal. Multiple cleanups can also
 * be registered via `onCleanup()`. Effects and memos created inside `fn`
 * belong to this run: they end when the effect runs again or is disposed.
 *
 * Writes made inside `fn` are applied once it returns, as in a `batch`.
 */
export function effect(fn: EffectCallback): () => void {
	const c = createComputation("effect", (self) => {
		const teardown = fn();
		if (typeof teardown === "function") self.cleanups.push(teardown);
	});
	batchDepth++;
	try {
		run(c);
	} finally {
		batchDepth--;
	}
	const stop = () => dispose(c);
	// Register with the ambient owner (a component's setup scope, or the
	// computation running now) so the effect is torn down when that scope
	// ends. `memo()` registers the same way.
	currentOwner?.push(stop);
	flushIfIdle();
	return stop;
}

/**
 * @internal Run `fn` when the scope being built now ends: the component whose
 * setup is running unmounts, or the effect running now runs again or is
 * disposed. Nothing at top level, where nothing ends.
 *
 * `onCleanup` is not that: it needs a running effect, and a component's setup
 * runs untracked, so a listener a helper removed through it was never removed.
 */
export function onDispose(fn: () => void): void {
	currentOwner?.push(fn);
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
 * signals re-run each affected observer at most once. A memo read inside
 * the batch is already up to date.
 */
export function batch<T>(fn: () => T): T {
	batchDepth++;
	try {
		return fn();
	} finally {
		batchDepth--;
		flushIfIdle();
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
 * Derived read-only signal — `fn` re-runs when a signal it reads changes and
 * the memo is read, and the latest return value is cached and handed out by
 * the returned accessor. A recomputation that returns an equal value
 * (`Object.is`, or `options.equals`) re-runs nothing that reads the memo.
 * Cleanups inside `fn` (via `onCleanup`) run on every recomputation.
 *
 * `equals` is how a memo that builds a new array or object each time stays
 * quiet when the content did not change:
 *
 *     const open = memo(() => rows().filter((r) => r.open), { equals: sameItems })
 */
export function memo<T>(
	fn: () => T,
	options?: { equals?: (a: T, b: T) => boolean },
): ReadSignal<T> {
	const equals = options?.equals ?? Object.is;
	// Filled by the first run, which happens below before anything can read.
	let box: { value: T } | undefined;
	const c = createComputation("memo", (self) => {
		const next = fn();
		if (box === undefined) {
			box = { value: next };
			return;
		}
		if (equals(box.value, next)) return;
		box.value = next;
		for (const reader of self.observers) mark(reader, DIRTY);
	});
	const node: Dependency = {
		observers: c.observers,
		refresh: () => update(c),
	};
	run(c);
	currentOwner?.push(() => dispose(c));
	const read = (): T => {
		if (c.state !== CLEAN) update(c);
		track(node);
		if (box === undefined) {
			throw new AuroraError(
				"E_AURORA_INTERNAL",
				"[aurora] memo: the first computation did not run",
			);
		}
		return box.value;
	};
	return Object.assign(read, { [SIGNAL_BRAND]: true as const });
}

function runCleanups(c: Computation): void {
	if (c.cleanups.length === 0) return;
	const queued = c.cleanups.splice(0, c.cleanups.length);
	for (const cleanup of queued) {
		try {
			cleanup();
		} catch {
			/* swallow — cleanup errors must not block sibling cleanups */
		}
	}
}

/** End what the computation's last run created. */
function disposeOwned(c: Computation): void {
	if (c.owned.length === 0) return;
	for (const end of c.owned.splice(0, c.owned.length)) end();
}

function detach(c: Computation): void {
	for (const dep of c.sources) dep.observers.delete(c);
	c.sources.clear();
}
