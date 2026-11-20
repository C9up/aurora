/**
 * A development-only count of what re-runs.
 *
 * A spurious re-render is invisible: the page looks the same, and only a menu
 * that closes by itself or a field that loses its caret gives it away. Switched
 * on, the counter hears every re-run the runtime makes — an effect or a memo
 * running again, a slot rebuilding what it shows, a list reconciling its rows,
 * an attribute or a property written again, a component's setup running — and
 * keeps a tally per kind and per element, optionally outlining each element
 * as it re-renders.
 *
 *     if (import.meta.env.DEV) countRerenders({ highlight: true })
 *
 * Off, it costs one property read at each place that could report: the
 * runtime only builds an event when a listener is installed.
 */

/** What re-ran. */
export type RerenderKind =
	| "effect"
	| "memo"
	| "slot"
	| "list"
	| "attribute"
	| "property"
	| "setup";

/** One re-run, as the runtime reports it. */
export interface RerenderEvent {
	readonly kind: RerenderKind;
	/**
	 * The node the re-run touched: the parent element of a slot or a list, the
	 * element of an attribute or a property. Absent for effects, memos and
	 * setups, which touch no node themselves. Typed as an object because the
	 * reactive core reports too and knows no DOM: in a browser it is an Element.
	 */
	readonly target?: object;
	/** The attribute or property written, or the setup function's name. */
	readonly name?: string;
	/** What to look at, when the runtime knows a cheaper way to render this. */
	readonly hint?: string;
}

/** A running count, from {@link countRerenders}. */
export interface RerenderCounter {
	/** How many re-runs of each kind were heard since the start or the last reset. */
	counts(): Record<RerenderKind, number>;
	/** The elements re-rendered most, most first. */
	top(limit?: number): Array<{ target: object; count: number }>;
	/** The setups that ran most, by function name, most first. */
	setups(limit?: number): Array<{ name: string; count: number }>;
	/** Start the tallies over. */
	reset(): void;
	/** Stop listening. The runtime goes back to reporting nothing. */
	stop(): void;
}

export interface RerenderOptions {
	/** Outline each element briefly as it re-renders. Browser only. */
	highlight?: boolean;
	/** `console.debug` every re-run. */
	log?: boolean;
	/** Called for every re-run, after it was counted. */
	onRerender?: (event: RerenderEvent) => void;
}

/** @internal Where the runtime reports. `emit` is unset unless a counter runs. */
export const probe: { emit: ((event: RerenderEvent) => void) | undefined } = {
	emit: undefined,
};

const listeners = new Set<(event: RerenderEvent) => void>();

function dispatch(event: RerenderEvent): void {
	for (const listener of listeners) listener(event);
}

function emptyCounts(): Record<RerenderKind, number> {
	return {
		effect: 0,
		memo: 0,
		slot: 0,
		list: 0,
		attribute: 0,
		property: 0,
		setup: 0,
	};
}

const OUTLINE = "2px solid rgb(244 63 94)";
const HIGHLIGHT_MS = 400;

/**
 * Start counting re-runs. Several counters can run at once; the runtime
 * reports nothing again once the last one is stopped.
 */
export function countRerenders(options: RerenderOptions = {}): RerenderCounter {
	let counts = emptyCounts();
	let byTarget = new Map<object, number>();
	let bySetup = new Map<string, number>();
	/** The outline each highlighted element had before, and its pending restore. */
	const outlined = new Map<
		object,
		{ style: object; previous: unknown; timer: ReturnType<typeof setTimeout> }
	>();

	// Through Reflect: this module is host-free, so it reads an element's
	// inline style as whatever object carries an `outline`, and a node that
	// has none (a native renderer's) is simply not outlined.
	function highlight(target: object): void {
		const style: unknown = Reflect.get(target, "style");
		if (typeof style !== "object" || style === null || !("outline" in style)) {
			return;
		}
		const pending = outlined.get(target);
		if (pending !== undefined) clearTimeout(pending.timer);
		const previous = pending?.previous ?? style.outline;
		Reflect.set(style, "outline", OUTLINE);
		const timer = setTimeout(() => {
			Reflect.set(style, "outline", previous);
			outlined.delete(target);
		}, HIGHLIGHT_MS);
		outlined.set(target, { style, previous, timer });
	}

	const listener = (event: RerenderEvent): void => {
		counts[event.kind]++;
		if (event.target !== undefined) {
			byTarget.set(event.target, (byTarget.get(event.target) ?? 0) + 1);
			if (options.highlight === true) highlight(event.target);
		}
		if (event.kind === "setup") {
			const name = event.name || "(anonymous)";
			bySetup.set(name, (bySetup.get(name) ?? 0) + 1);
		}
		if (options.log === true && typeof console !== "undefined") {
			console.debug(
				"[aurora] re-render",
				event.kind,
				event.name ?? "",
				event.target ?? "",
				event.hint ?? "",
			);
		}
		options.onRerender?.(event);
	};
	listeners.add(listener);
	probe.emit = dispatch;

	return {
		counts: () => ({ ...counts }),
		top(limit = 10) {
			return [...byTarget]
				.map(([target, count]) => ({ target, count }))
				.sort((a, b) => b.count - a.count)
				.slice(0, limit);
		},
		setups(limit = 10) {
			return [...bySetup]
				.map(([name, count]) => ({ name, count }))
				.sort((a, b) => b.count - a.count)
				.slice(0, limit);
		},
		reset() {
			counts = emptyCounts();
			byTarget = new Map();
			bySetup = new Map();
		},
		stop() {
			listeners.delete(listener);
			if (listeners.size === 0) probe.emit = undefined;
			for (const { style, previous, timer } of outlined.values()) {
				clearTimeout(timer);
				Reflect.set(style, "outline", previous);
			}
			outlined.clear();
		},
	};
}
