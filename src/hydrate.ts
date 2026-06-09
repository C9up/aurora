/**
 * Hydration — adopt SSR-rendered HTML in the browser without rebuilding
 * the DOM.
 *
 * `hydrate(container, factory)` runs the same component factory used
 * server-side, recomputes the slot bindings, and attaches them to the
 * existing nodes. Where SSR emitted plain text for `${signal}`, hydrate
 * locates the same text node (via path resolution against the cloned
 * template) and starts an effect that updates it on signal change.
 *
 * Implementation note: we still run `getTemplate(strings)` to know
 * where each slot lives, then walk the LIVE container tree using the
 * same path. SSR output must match the shape of the parsed template
 * for hydration to find the right node — same constraint as React's
 * hydration mismatch warning.
 */

import { readComponentLifecycle } from "./component.js";
import { getTemplate } from "./html.js";
import { effect, isSignal } from "./reactive.js";
import { type Disposer, mount } from "./render.js";
import {
	type AttrSlot,
	type BooleanAttrSlot,
	type EffectCallback,
	type EventSlot,
	isTemplateResult,
	type NodePath,
	type PropSlot,
	type Slot,
	type TemplateResult,
} from "./types.js";

/**
 * Process-scoped flag so the "reactive nested template not reactive
 * after hydration" warning fires once, not on every matching slot.
 * Only reached on LEGACY markup that predates SSR boundary markers
 * (the markered path keeps the subtree reactive — no warning).
 */
let nestedReactiveWarned = false;

/** @internal Reset the warn-once flag (tests). */
export function resetHydrateWarnings(): void {
	nestedReactiveWarned = false;
}

// Boundary-marker comment payloads (kept in sync with ssr.ts).
const SLOT_START = "$";
const SLOT_END = "/$";

/**
 * An SSR-emitted `<!--$-->…<!--/$-->` pair delimiting a reactive
 * structured slot's rendered subtree.
 */
interface MarkerPair {
	start: Comment;
	end: Comment;
}

/**
 * Document-ordered list of marker pairs + a consume cursor. Reactive
 * structured text slots consume pairs in hydration order, which matches
 * the document order of their `<!--$-->` start markers (a parent slot's
 * start precedes its children's, and hydration visits parents first).
 */
interface MarkerCursor {
	pairs: MarkerPair[];
	i: number;
	/**
	 * The Document this hydration root belongs to. Threaded through (not
	 * a module global) so concurrent `hydrate()` calls on different
	 * documents / iframes each create swapped-in text nodes in THEIR own
	 * document — a shared global would let a second root's document
	 * clobber the first's.
	 */
	doc: Document;
}

/**
 * Collect every `<!--$-->…<!--/$-->` pair under `container`, ordered by
 * the start marker's document position. Nesting is resolved with a
 * stack so an inner pair's start/end never cross an outer pair's.
 */
function collectMarkerPairs(container: Node): MarkerPair[] {
	// Depth-first, document-order walk. We DON'T use createTreeWalker:
	// some DOM implementations (happy-dom under vitest) ignore the
	// numeric `whatToShow` filter and yield nothing. A manual recursion
	// over childNodes is portable and visits comments in document order,
	// so the stack pairs each `<!--$-->` with its matching `<!--/$-->`
	// and the result is already start-ordered (no sort needed).
	const pairs: MarkerPair[] = [];
	const stack: Comment[] = [];
	const visit = (node: Node): void => {
		if (node.nodeType === 8 /* Comment */) {
			const c = node as Comment;
			if (c.data === SLOT_START) {
				stack.push(c);
			} else if (c.data === SLOT_END) {
				const start = stack.pop();
				if (start !== undefined) pairs.push({ start, end: c });
			}
			return;
		}
		for (
			let child = node.firstChild;
			child !== null;
			child = child.nextSibling
		) {
			visit(child);
		}
	};
	visit(container);
	// `pairs` is in END order (innermost closes first). Sort by start's
	// document position so consumption matches hydration's
	// parents-before-children visit order.
	pairs.sort((a, b) =>
		a.start.compareDocumentPosition(b.start) &
		4 /* DOCUMENT_POSITION_FOLLOWING */
			? -1
			: 1,
	);
	return pairs;
}

/** Render a value (template / array / scalar) to detached client nodes. */
function renderValueToNodes(
	value: unknown,
	cleanups: Disposer[],
	mountHooks: Array<EffectCallback>,
	doc: Document,
): ChildNode[] {
	if (value === null || value === undefined || value === false) return [];
	if (Array.isArray(value)) {
		const out: ChildNode[] = [];
		for (const item of value) {
			out.push(...renderValueToNodes(item, cleanups, mountHooks, doc));
		}
		return out;
	}
	if (isTemplateResult(value)) {
		const frag = mount(value, cleanups, [], mountHooks);
		return Array.from(frag.childNodes);
	}
	if (value instanceof Node) return [value as ChildNode];
	return [doc.createTextNode(String(value))];
}

/**
 * Wire a reactive structured slot (signal/function → nested template or
 * array) using its SSR boundary-marker pair. The first run hydrates the
 * initial value against the captured SSR nodes (reusing server markup,
 * no flash); every subsequent signal change disposes the old subtree
 * and client-renders the new value into the same `<!--$-->…<!--/$-->`
 * range — so the DOM stays correct on branch changes instead of going
 * stale.
 */
function hydrateReactiveStructured(
	fn: () => unknown,
	pair: MarkerPair,
	cleanups: Disposer[],
	mountHooks: Array<EffectCallback>,
	markerCursor: MarkerCursor,
): void {
	const { start, end } = pair;
	let currentNodes: ChildNode[] = [];
	for (let n = start.nextSibling; n !== null && n !== end; n = n.nextSibling) {
		currentNodes.push(n as ChildNode);
	}
	let localCleanups: Disposer[] = [];
	let firstRun = true;

	const dispose = effect(() => {
		const next = fn();
		if (firstRun) {
			firstRun = false;
			// Reuse SSR markup: hydrate reactive bindings INSIDE the nested
			// template against the captured nodes. Inner boundary markers
			// are consumed from the same cursor (document order).
			if (isTemplateResult(next)) {
				hydrateTemplateResult(
					next,
					currentNodes,
					localCleanups,
					mountHooks,
					markerCursor,
				);
			}
			return;
		}
		// Signal changed post-hydration: tear down the old subtree's
		// effects/listeners, drop its nodes, client-render the new value
		// into the same marker range.
		for (const d of localCleanups) d();
		localCleanups = [];
		for (const n of currentNodes) n.remove();
		currentNodes = [];
		const parent = end.parentNode;
		if (parent === null) return;
		const fresh = renderValueToNodes(
			next,
			localCleanups,
			mountHooks,
			markerCursor.doc,
		);
		for (const n of fresh) parent.insertBefore(n, end);
		currentNodes = fresh;
	});

	cleanups.push(() => {
		dispose();
		for (const d of localCleanups) d();
		localCleanups = [];
	});
}

/**
 * Adopt SSR markup inside `container`. `factory` is the same function
 * that was rendered server-side — its output (a TemplateResult tree)
 * tells hydrate which slots to wire.
 *
 * Returns a `Disposer` that detaches every effect and event listener,
 * leaving the DOM in place.
 */
export function hydrate(
	container: Element,
	factory: () => TemplateResult,
): Disposer {
	const cleanups: Disposer[] = [];
	const mountHooks: Array<EffectCallback> = [];
	const markerCursor: MarkerCursor = {
		pairs: collectMarkerPairs(container),
		i: 0,
		doc: container.ownerDocument ?? document,
	};
	const result = factory();
	hydrateTemplateResult(
		result,
		Array.from(container.childNodes),
		cleanups,
		mountHooks,
		markerCursor,
	);
	for (const hook of mountHooks) {
		try {
			const teardown = hook();
			if (typeof teardown === "function") cleanups.push(teardown);
		} catch {
			/* swallow */
		}
	}
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		for (const c of cleanups.splice(0)) c();
	};
}

/**
 * Hydrate a TemplateResult against a list of live root nodes. The list
 * is sliced as we consume children — text-slot anchors don't exist in
 * the SSR output (we inlined the value), so we count text-slot
 * boundaries by reading the static `strings` between values.
 */
function hydrateTemplateResult(
	result: TemplateResult,
	liveNodes: ChildNode[],
	cleanups: Disposer[],
	mountHooks: Array<EffectCallback>,
	markerCursor: MarkerCursor,
): void {
	const lifecycle = readComponentLifecycle(result);
	if (lifecycle) {
		for (const hook of lifecycle.mountHooks) mountHooks.push(hook);
		for (const c of lifecycle.cleanups) cleanups.push(c);
	}

	// Hydration walks via the SAME path resolver as render, but against
	// a synthetic root that mimics the parsed template's child list.
	const tpl = getTemplate(result.strings);
	// The live container's children should structurally match the
	// template's content children. Wrap them in a transient DocumentFragment
	// for path resolution — DocumentFragment.childNodes is the same view
	// we walked during parse.
	const syntheticRoot = {
		childNodes: liveNodes,
	} as unknown as ParentNode;

	for (let i = 0; i < tpl.slots.length; i++) {
		const slot = tpl.slots[i];
		const liveNode = resolvePathLive(syntheticRoot, slot.path, liveNodes);
		if (!liveNode) {
			// Path missed in the live DOM — SSR markup diverges from the
			// parsed template's shape. Surfacing the mismatch beats silent
			// dead bindings: a stale slot doesn't update, but the developer
			// has no clue why until they hit print-line debugging.
			if (typeof console !== "undefined") {
				console.warn(
					`[aurora] hydration mismatch: slot ${i} (${slot.kind}) path ${slot.path.join(".")} not found in live DOM — SSR markup may diverge from the client template (did you forget to rerender after a server change?)`,
				);
			}
			continue;
		}
		hydrateSlot(
			slot,
			liveNode,
			result.values[i],
			cleanups,
			mountHooks,
			markerCursor,
		);
	}
}

/**
 * Resolve a slot's path against the LIVE DOM. The first index of the
 * path indexes into `liveNodes` directly (since we packaged them in a
 * synthetic root); subsequent indices walk the child node list normally.
 *
 * Text-slot paths point to a comment marker that doesn't exist in
 * hydration markup — we tolerate the miss and return null.
 */
function resolvePathLive(
	_root: ParentNode,
	path: NodePath,
	rootNodes: ChildNode[],
): Node | null {
	if (path.length === 0) return null;
	let node: Node | null = rootNodes[path[0]] ?? null;
	for (let i = 1; node && i < path.length; i++) {
		node = node.childNodes[path[i]] ?? null;
	}
	return node;
}

function hydrateSlot(
	slot: Slot,
	node: Node,
	value: unknown,
	cleanups: Disposer[],
	mountHooks: Array<EffectCallback>,
	markerCursor: MarkerCursor,
): void {
	switch (slot.kind) {
		case "text":
			hydrateTextSlot(node, value, cleanups, mountHooks, markerCursor);
			return;
		case "attr":
			hydrateAttrSlot(slot, node as Element, value, cleanups);
			return;
		case "boolean-attr":
			hydrateBooleanAttrSlot(slot, node as Element, value, cleanups);
			return;
		case "prop":
			hydratePropSlot(slot, node as Element, value, cleanups);
			return;
		case "event":
			hydrateEventSlot(slot, node as Element, value, cleanups);
			return;
	}
}

/**
 * Hydrate a text slot. SSR inlined the value as a text node (or skipped
 * it for null/false/undefined). We locate the **first text node sibling
 * preceding the path's terminal index** — that's where SSR wrote the
 * value — and wire an effect that overwrites its `data` on changes.
 *
 * For reactive values (signals/functions), the effect updates the
 * existing text node in place. For nested TemplateResults, we
 * recursively hydrate against the captured sibling range.
 */
function hydrateTextSlot(
	commentMarker: Node,
	value: unknown,
	cleanups: Disposer[],
	mountHooks: Array<EffectCallback>,
	markerCursor: MarkerCursor,
): void {
	// The path lands on the comment marker that EXISTS in the parsed
	// template but not in SSR output. Hydration walks the live siblings
	// to find the text node that holds the SSR value.
	// Strategy: the comment was located at child index N inside its
	// parent; SSR wrote the value as the immediately-preceding text
	// node (or nothing for null/false). Live node here is whatever the
	// path resolution returned — often a text node, sometimes an
	// element (for nested templates). We rebind in-place.
	if (isSignal(value) || typeof value === "function") {
		const fn = value as () => unknown;
		// First, evaluate eagerly to detect a structured value (nested
		// TemplateResult / array) — those need a SWAP on change, which
		// means a node range, which the SSR boundary markers give us.
		const first = fn();
		if (isTemplateResult(first) || Array.isArray(first)) {
			const pair = markerCursor.pairs[markerCursor.i];
			if (pair !== undefined) {
				markerCursor.i += 1;
				hydrateReactiveStructured(fn, pair, cleanups, mountHooks, markerCursor);
				return;
			}
			// LEGACY markup (no boundary markers — produced by an older
			// SSR build): we can't locate the subtree's range, so we
			// hydrate once and warn that the subtree won't stay reactive.
			// Fresh SSR always emits markers, so this path is dead for
			// matched server/client builds.
			if (!nestedReactiveWarned && typeof console !== "undefined") {
				nestedReactiveWarned = true;
				console.warn(
					"[aurora] a reactive expression hydrated to a nested template but " +
						"the SSR markup has no boundary markers — the subtree will not update " +
						"on signal changes. Re-render with a current @c9up/aurora SSR build.",
				);
			}
			if (isTemplateResult(first)) {
				hydrateTemplateResult(
					first,
					[commentMarker as ChildNode],
					cleanups,
					mountHooks,
					markerCursor,
				);
			}
			return;
		}
		let textNode =
			commentMarker.nodeType === 3 /* TEXT */
				? (commentMarker as Text)
				: commentMarker.previousSibling?.nodeType === 3
					? (commentMarker.previousSibling as Text)
					: null;
		if (
			!textNode &&
			commentMarker.nodeType === 8 /* Comment */ &&
			commentMarker.parentNode
		) {
			// Empty SSR text slot: a `<!---->` placeholder holds the position
			// (see ssr.ts). Materialize the reactive text node there — node
			// count stays 1, so sibling slot paths remain aligned.
			const fresh = (commentMarker.ownerDocument ?? document).createTextNode(
				"",
			);
			commentMarker.parentNode.replaceChild(fresh, commentMarker);
			textNode = fresh;
		}
		if (!textNode) return;
		const dispose = effect(() => {
			const v = fn();
			textNode.data = v == null || v === false ? "" : String(v);
		});
		cleanups.push(dispose);
		return;
	}
	if (isTemplateResult(value)) {
		hydrateTemplateResult(
			value,
			[commentMarker as ChildNode],
			cleanups,
			mountHooks,
			markerCursor,
		);
		return;
	}
	// Static value — SSR rendered it once and we don't need to do
	// anything. The text already lives in the DOM.
}

function hydrateAttrSlot(
	slot: AttrSlot,
	el: Element,
	value: unknown,
	cleanups: Disposer[],
): void {
	function apply(v: unknown): void {
		if (v === null || v === undefined || v === false) {
			el.removeAttribute(slot.name);
		} else if (v === true) {
			el.setAttribute(slot.name, "");
		} else {
			el.setAttribute(slot.name, String(v));
		}
	}
	if (isSignal(value) || typeof value === "function") {
		const dispose = effect(() => apply((value as () => unknown)()));
		cleanups.push(dispose);
	}
	// Static attrs need no hydration — SSR already wrote them.
}

function hydrateBooleanAttrSlot(
	slot: BooleanAttrSlot,
	el: Element,
	value: unknown,
	cleanups: Disposer[],
): void {
	function apply(v: unknown): void {
		if (v) el.setAttribute(slot.name, "");
		else el.removeAttribute(slot.name);
	}
	if (isSignal(value) || typeof value === "function") {
		const dispose = effect(() => apply((value as () => unknown)()));
		cleanups.push(dispose);
	}
}

function hydratePropSlot(
	slot: PropSlot,
	el: Element,
	value: unknown,
	cleanups: Disposer[],
): void {
	function apply(v: unknown): void {
		(el as unknown as Record<string, unknown>)[slot.name] = v;
	}
	if (isSignal(value) || typeof value === "function") {
		const dispose = effect(() => apply((value as () => unknown)()));
		cleanups.push(dispose);
	} else {
		apply(value);
	}
}

function hydrateEventSlot(
	slot: EventSlot,
	el: Element,
	value: unknown,
	cleanups: Disposer[],
): void {
	if (typeof value !== "function") return;
	const handler = value as EventListener;
	el.addEventListener(slot.event, handler);
	cleanups.push(() => el.removeEventListener(slot.event, handler));
}
