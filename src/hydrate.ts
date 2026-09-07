/// <reference lib="dom" />
// This file uses browser globals. The reference pulls the DOM lib in for
// THIS file whatever `lib` the consumer configured, so a Node app
// typechecking against our sources does not trip over `window` —
// `types: "./src/index.ts"` means every consumer reads them.
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
		// The renderer collects hooks in a queue now; hydrate keeps its own
		// flat list, so it hands one over and takes back what was collected.
		const nested = { hooks: mountHooks, flushed: false };
		const frag = mount(value, cleanups, [], nested);
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
			// value against the captured nodes. Inner boundary markers are
			// consumed from the same cursor (document order) — for an ARRAY this
			// MUST recurse into every item, else the items' marker pairs go
			// unconsumed and the cursor desyncs, wiring slots AFTER the list to
			// the wrong range (SSR list "present but not painted").
			if (isTemplateResult(next)) {
				hydrateTemplateResult(
					next,
					currentNodes,
					localCleanups,
					mountHooks,
					markerCursor,
				);
			} else if (Array.isArray(next)) {
				hydrateArrayItems(
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
 * Top-level live (SSR) node count a value contributes inside an array slot: a
 * TemplateResult contributes its template's root-node count, a nested array the
 * sum of its items, a non-empty scalar one text node, null/undefined/false none.
 * Used to slice the array's range per item during hydration.
 */
function liveNodeCount(value: unknown): number {
	if (value === null || value === undefined || value === false) return 0;
	if (isTemplateResult(value)) {
		return getTemplate(value.strings).element.content.childNodes.length;
	}
	if (Array.isArray(value)) {
		let n = 0;
		for (const v of value) n += liveNodeCount(v);
		return n;
	}
	return 1; // scalar → one inlined text node
}

/**
 * The first and last top-level nodes an item contributes to the live DOM, as
 * node types.
 *
 * Needed because the browser MERGES adjacent text nodes when it parses the SSR
 * HTML. Two items whose markup touches — one ending in text, the next starting
 * with text — share a single live node at their boundary, and counting them
 * separately shifts every following item by one. That is why a list of one
 * hydrates and a list of two does not: with one item there is no boundary.
 *
 * Read from the parsed TEMPLATE, which is what both sides agree on: a slot that
 * renders to nothing still occupies a comment-marked range, and comments never
 * merge with text.
 */
function edgeNodeTypes(value: unknown): { first: number; last: number } | null {
	if (value === null || value === undefined || value === false) return null;
	if (isTemplateResult(value)) {
		const children = getTemplate(value.strings).element.content.childNodes;
		const first = children[0];
		const last = children[children.length - 1];
		if (!first || !last) return null;
		return { first: first.nodeType, last: last.nodeType };
	}
	if (Array.isArray(value)) {
		// A nested array's edges are its own first and last contributing items.
		let first: number | null = null;
		let last: number | null = null;
		for (const v of value) {
			const edges = edgeNodeTypes(v);
			if (!edges) continue;
			if (first === null) first = edges.first;
			last = edges.last;
		}
		return first === null || last === null ? null : { first, last };
	}
	// Scalar — inlined as one text node, so it merges on both sides.
	return { first: 3 /* Text */, last: 3 /* Text */ };
}

/**
 * Hydrate the items of a reactive array against the SSR nodes inside its marker
 * range. Each item is hydrated against its own slice of the (marker-collapsed)
 * range, IN ORDER, so every item's inner marker pairs are consumed in document
 * order and the global cursor stays aligned for slots AFTER the list.
 *
 * Item templates used to need a shape — single root, no surrounding whitespace,
 * no bare adjacent scalars — because the slice was a straight node count and
 * the browser merges adjacent text nodes. A prettier-formatted item template
 * was enough to break it, silently, from the second item onwards. The boundary
 * is now accounted for (see `edgeNodeTypes`), so any item shape hydrates.
 */
function hydrateArrayItems(
	items: unknown[],
	rangeNodes: ChildNode[],
	cleanups: Disposer[],
	mountHooks: Array<EffectCallback>,
	markerCursor: MarkerCursor,
): void {
	const nodes = collapseMarkerRanges(rangeNodes);
	let offset = 0;
	/** The node type the previous item ended on, for the merge check below. */
	let previousLast: number | null = null;
	for (const item of items) {
		const count = liveNodeCount(item);
		const edges = edgeNodeTypes(item);
		// Text-node merge at the item boundary: the previous item's trailing
		// text and this one's leading text are ONE node in the live DOM, so this
		// item starts where the previous one appeared to end. Without this the
		// slice slides by one per boundary and every item after the first
		// resolves its slot paths against the wrong nodes — reported as
		// "slot 0 (attr) path 1.0 not found", once per slot per item.
		if (previousLast === 3 && edges?.first === 3) offset -= 1;
		if (isTemplateResult(item)) {
			hydrateTemplateResult(
				item,
				nodes.slice(offset, offset + count),
				cleanups,
				mountHooks,
				markerCursor,
			);
		} else if (Array.isArray(item)) {
			hydrateArrayItems(
				item,
				nodes.slice(offset, offset + count),
				cleanups,
				mountHooks,
				markerCursor,
			);
		}
		offset += count;
		// An item that contributes nothing (null/false) leaves the boundary
		// where the last CONTRIBUTING item put it.
		if (edges) previousLast = edges.last;
	}
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

	// An attribute interpolating several slots — `class="static ${a} ${b}"` — is
	// ONE attribute value built from all of them plus the static segments in
	// between. Binding each slot on its own would have the last writer win and
	// wipe the statics, which is what render.ts already avoids server-side.
	const multiGroups = new Map<string, MultiAttrGroup>();

	for (const [i, slot] of tpl.slots.entries()) {
		const liveNode = resolvePathLive(slot.path, liveNodes);
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
		if (slot.kind === "attr" && slot.staticParts !== undefined) {
			collectMultiAttr(
				slot,
				liveNode as Element,
				result.values[i],
				multiGroups,
			);
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

	for (const group of multiGroups.values()) {
		applyMultiAttrGroup(group, cleanups);
	}
}

/** One attribute whose value is assembled from several slots. */
interface MultiAttrGroup {
	el: Element;
	name: string;
	staticParts: readonly string[];
	values: unknown[];
}

function collectMultiAttr(
	slot: AttrSlot,
	el: Element,
	value: unknown,
	groups: Map<string, MultiAttrGroup>,
): void {
	if (!slot.staticParts) return;
	const key = `${slot.name}::${(slot.path as readonly number[]).join(".")}`;
	let group = groups.get(key);
	if (!group) {
		group = { el, name: slot.name, staticParts: slot.staticParts, values: [] };
		groups.set(key, group);
	}
	group.values.push(value);
}

function applyMultiAttrGroup(
	group: MultiAttrGroup,
	cleanups: Disposer[],
): void {
	function join(): string {
		let out = group.staticParts[0] ?? "";
		for (let i = 0; i < group.values.length; i++) {
			const v = group.values[i];
			const resolved =
				isSignal(v) || typeof v === "function" ? (v as () => unknown)() : v;
			out += resolved == null || resolved === false ? "" : String(resolved);
			out += group.staticParts[i + 1] ?? "";
		}
		return out;
	}

	const hasReactive = group.values.some(
		(v) => isSignal(v) || typeof v === "function",
	);
	if (hasReactive) {
		// SSR already wrote the joined value; re-joining on every tick is what
		// keeps the statics in place when only one part changes.
		cleanups.push(
			effect(() => {
				group.el.setAttribute(group.name, join());
			}),
		);
	}
	// Fully static groups need nothing: SSR wrote the final value.
}

/**
 * Resolve a slot's path against the LIVE DOM. The first index of the
 * path indexes into `liveNodes` directly (since we packaged them in a
 * synthetic root); subsequent indices walk the child node list normally.
 *
 * Text-slot paths point to a comment marker that doesn't exist in
 * hydration markup — we tolerate the miss and return null.
 */
/**
 * Collapse each top-level `<!--$-->…<!--/$-->` range in `nodes` to a SINGLE
 * entry (its start marker), dropping the in-range content + end marker from the
 * count. SSR expands a structured slot (reactive OR a direct nested template)
 * to a node RANGE, but the parsed client template counts every slot as exactly
 * ONE comment node — so without this collapse the extra range nodes shift the
 * childNode index of every FOLLOWING sibling slot (dead bindings / "slot path
 * not found"). Nested ranges (depth > 0) are skipped wholesale: they belong to
 * the outer slot's content and are hydrated when we recurse into it.
 */
function collapseMarkerRanges(nodes: ChildNode[]): ChildNode[] {
	const out: ChildNode[] = [];
	let depth = 0;
	for (const n of nodes) {
		if (n.nodeType === 8 /* Comment */) {
			const data = (n as Comment).data;
			if (data === SLOT_START) {
				if (depth === 0) out.push(n); // the whole range counts as one node
				depth += 1;
				continue;
			}
			if (data === SLOT_END) {
				if (depth > 0) depth -= 1;
				continue;
			}
		}
		if (depth === 0) out.push(n);
	}
	return out;
}

function resolvePathLive(path: NodePath, rootNodes: ChildNode[]): Node | null {
	if (path.length === 0) return null;
	// Collapse marker ranges at EVERY level so the live child list matches the
	// parsed template's one-node-per-slot shape (see collapseMarkerRanges).
	let children = collapseMarkerRanges(rootNodes);
	const [head, ...rest] = path;
	if (head === undefined) return null;
	let node: Node | null = children[head] ?? null;
	for (const step of rest) {
		if (!node) break;
		children = collapseMarkerRanges(Array.from(node.childNodes));
		node = children[step] ?? null;
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
	// Type guard: an attr/bool/prop/event slot needs an Element. On a SSR↔client
	// structural desync the path can resolve to an EXISTING node of the wrong
	// type (Text/Comment); casting it to Element and calling setAttribute would
	// throw "setAttribute is not a function". Skip the binding (fail-soft) rather
	// than crash hydration. Text slots accept text/comment/element, so they pass.
	if (slot.kind !== "text" && node.nodeType !== 1) {
		if (typeof console !== "undefined") {
			console.warn(
				`[aurora] hydrate: slot (${slot.kind}) path ${slot.path.join(".")} resolved to a non-element node — skipping binding`,
			);
		}
		return;
	}
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
 * Hydrate a text slot against its SSR boundary-marker pair. A reactive slot
 * (signal/function) always goes through the swap-capable structured path so a
 * value that changes type (scalar ↔ template ↔ array) re-renders correctly; a
 * direct template/array adopts its SSR range once; a static scalar is left as-is.
 */
function hydrateTextSlot(
	commentMarker: Node,
	value: unknown,
	cleanups: Disposer[],
	mountHooks: Array<EffectCallback>,
	markerCursor: MarkerCursor,
): void {
	// Every text slot is SSR-wrapped in a <!--$-->…<!--/$--> pair, and its path
	// resolves (via collapseMarkerRanges) to the start marker. Consume the
	// matching pair in document order and bind within its range.
	const pair = markerCursor.pairs[markerCursor.i];
	if (pair === undefined) {
		// Legacy markup without per-slot markers (mismatched older SSR build).
		legacyHydrateTextSlot(
			commentMarker,
			value,
			cleanups,
			mountHooks,
			markerCursor,
		);
		return;
	}
	markerCursor.i += 1;

	const reactiveFn =
		isSignal(value) || typeof value === "function"
			? (value as () => unknown)
			: null;

	// Reactive slot — its value TYPE can change across renders (scalar ↔ template
	// ↔ array), e.g. `${() => collapsed() ? '' : html`<span>…</span>`}`. Always
	// use the swap-capable structured path: its effect re-renders the value
	// (whatever type) into the marker range via renderValueToNodes. Locking a
	// reactive slot to a scalar text-node effect (based on its FIRST value) would
	// String() a later template/array into "[object Object]".
	if (reactiveFn) {
		hydrateReactiveStructured(
			reactiveFn,
			pair,
			cleanups,
			mountHooks,
			markerCursor,
		);
		return;
	}

	// Non-reactive (direct) value — adopt the SSR range once.
	if (isTemplateResult(value) || Array.isArray(value)) {
		const range: ChildNode[] = [];
		for (
			let n = pair.start.nextSibling;
			n !== null && n !== pair.end;
			n = n.nextSibling
		) {
			range.push(n as ChildNode);
		}
		if (isTemplateResult(value)) {
			hydrateTemplateResult(value, range, cleanups, mountHooks, markerCursor);
		} else if (Array.isArray(value)) {
			// Direct array — hydrate each item so its inner marker pairs are
			// consumed and the cursor stays aligned.
			hydrateArrayItems(value, range, cleanups, mountHooks, markerCursor);
		}
	}
	// else: static scalar — already rendered between the markers.
}

/**
 * Pre-marker fallback — best-effort hydration when the SSR markup carries no
 * per-slot boundary markers (a mismatched older SSR build). Current builds wrap
 * every text slot, so this path is dead for matched server/client versions.
 */
function legacyHydrateTextSlot(
	commentMarker: Node,
	value: unknown,
	cleanups: Disposer[],
	mountHooks: Array<EffectCallback>,
	markerCursor: MarkerCursor,
): void {
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
		// DIRECT nested template (component composition, `${Layout({…})}`). SSR
		// wrapped it in a boundary-marker pair (same scheme as a reactive
		// structured slot). Consume the pair in document order and hydrate the
		// nested template against its captured range — wiring inner bindings to
		// the SSR nodes and keeping the marker cursor aligned.
		const pair = markerCursor.pairs[markerCursor.i];
		if (pair !== undefined) {
			markerCursor.i += 1;
			const range: ChildNode[] = [];
			for (
				let n = pair.start.nextSibling;
				n !== null && n !== pair.end;
				n = n.nextSibling
			) {
				range.push(n as ChildNode);
			}
			hydrateTemplateResult(value, range, cleanups, mountHooks, markerCursor);
			return;
		}
		// Legacy markup without markers (older SSR build): best-effort against
		// the single resolved node.
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
		// Reflect.set rather than a cast: writing an arbitrary property onto an
		// element is exactly what Reflect is for, and it does not require
		// claiming the element is something it is not.
		Reflect.set(el, slot.name, v);
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
