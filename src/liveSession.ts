/**
 * Live components — server-resident reactive UI CORE. The state lives on the
 * server as ordinary aurora signals; this module turns a fine-grained signal
 * change into a PRECISE per-slot patch (`{slot, value}`) instead of re-rendering
 * the whole component. That precision — each signal already knows which template
 * slot it feeds — is the angle that beats HTML-diffing live-view libraries.
 *
 * This is the transport-agnostic core: mount a session, render its initial HTML,
 * dispatch events that mutate signals, and drain / subscribe to the patches
 * produced. The transport stack (broadcast / client / registry / router /
 * server) builds ON this and re-exports through the `./live.js` barrel — kept in
 * a separate module so those transport files import the core WITHOUT forming an
 * import cycle back through the barrel.
 *
 * Node-free / isomorphic: uses only `signal`/`effect`/`renderToString`.
 */

import { effect, isSignal } from "./reactive.js";
import { renderToString } from "./ssr.js";
import type { TemplateResult } from "./types.js";

/** A precise per-slot update: slot index (positional in the template) + value. */
export interface SlotPatch {
	slot: number;
	value: string;
}

/** A live component: its reactive view + named event handlers that mutate it. */
export interface LiveComponentDefinition {
	/** The reactive view. Slots reading signals become live-patchable. */
	view: TemplateResult;
	/**
	 * Event handlers, by name. A client interaction (`@click="increment"`)
	 * dispatches one of these; it mutates the component's signals, which the
	 * patch tracker turns into a `{slot, value}` patch.
	 */
	handlers?: Record<string, (payload?: unknown) => void>;
}

/** A mounted live component instance — one per connected client session. */
export interface LiveSession {
	/** Initial server-side render (the first full-HTML response). */
	renderToString(): string;
	/** Run a named handler (mutates signals); emits a patch for the batch. */
	dispatch(event: string, payload?: unknown): void;
	/** Collect + clear the patches accumulated since the last drain (pull model). */
	drainPatches(): SlotPatch[];
	/**
	 * Subscribe to patches as they are produced (push model — what the relay
	 * transport hooks into). Use `onPatch` OR `drainPatches`, not both.
	 */
	onPatch(listener: (patch: SlotPatch[]) => void): () => void;
	/** Stop every effect — call on client disconnect to free the session. */
	dispose(): void;
}

/**
 * Mount a live session from a definition factory. Call once per connected
 * client: the factory's signals become that session's private state. To SHARE
 * state across sessions, close the factory over a signal created OUTSIDE it —
 * every session then reads the same signal and patches on its change.
 */
export function mountLiveSession(
	factory: () => LiveComponentDefinition,
): LiveSession {
	const { view, handlers = {} } = factory();
	const listeners = new Set<(patch: SlotPatch[]) => void>();
	// slot → latest value. `pending` = current (un-flushed) batch; `buffer` =
	// accumulated for pull consumers. Both keyed by slot so repeated writes in
	// one batch collapse to the last value.
	const pending = new Map<number, string>();
	const buffer = new Map<number, string>();
	let priming = true;
	let flushScheduled = false;

	const flush = (): void => {
		flushScheduled = false;
		if (pending.size === 0) return;
		const patch: SlotPatch[] = [];
		for (const [slot, value] of pending) {
			patch.push({ slot, value });
			buffer.set(slot, value);
		}
		pending.clear();
		for (const listener of listeners) listener(patch);
	};

	const scheduleFlush = (): void => {
		if (flushScheduled) return;
		flushScheduled = true;
		queueMicrotask(flush);
	};

	// One fine-grained effect per reactive slot. The priming run only
	// subscribes; later runs (a signal changed) record the slot's new value.
	const stops = view.values.map((value, slot) => {
		if (!isSignal(value) && typeof value !== "function") return () => {};
		return effect(() => {
			const next = String((value as () => unknown)());
			if (priming) return;
			pending.set(slot, next);
			scheduleFlush();
		});
	});
	priming = false;

	return {
		renderToString: () => renderToString(view),
		dispatch(event, payload) {
			const handler = handlers[event];
			if (!handler) return;
			handler(payload);
			flush(); // synchronous — one patch per dispatch (batches the handler's writes)
		},
		drainPatches() {
			flush();
			const patch: SlotPatch[] = [];
			for (const [slot, value] of buffer) patch.push({ slot, value });
			buffer.clear();
			return patch;
		},
		onPatch(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose() {
			for (const stop of stops) stop();
			listeners.clear();
			pending.clear();
			buffer.clear();
		},
	};
}
