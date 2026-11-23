/// <reference lib="dom" preserve="true" />
// This file uses browser globals. The reference pulls the DOM lib in for
// THIS file whatever `lib` the consumer configured, so a Node app
// typechecking against our sources does not trip over `window` —
// `types: "./src/index.ts"` means every consumer reads them.
/**
 * Render a `TemplateResult` to the DOM and keep it reactive.
 *
 * `render(template, container)` clones the parsed `<template>`, walks to
 * each slot, attaches the corresponding value (with `effect()` for any
 * reactive expression), and appends the result to the container. The
 * returned dispose function tears down every effect and removes the
 * mounted nodes.
 */

import { getTemplate } from "./compile.js";
import { bindTemplateContext, readComponentLifecycle } from "./component.js";
import { type EachList, readEach, readEachItems } from "./each.js";
import { E_AURORA_DUPLICATE_KEY, E_AURORA_INTERNAL } from "./errors.js";
import {
	firstWindow,
	LazyLayout,
	type LazyList,
	type LazyView,
	sameWindow,
} from "./lazy.js";
import { bindMotionDom, bindScrollDom } from "./motionDom.js";
import {
	isChildNode,
	isCommentNode,
	isElementNode,
	isFragmentNode,
} from "./nodes.js";
import {
	batch,
	effect,
	isSignal,
	memo,
	readValue,
	type Signal,
	setOwner,
	signal,
	untrack,
} from "./reactive.js";
import { probe } from "./rerenders.js";
import { assertNotMarkup, assertPropertyValue } from "./templateScanner.js";
import {
	type AttrSlot,
	type BooleanAttrSlot,
	type Disposer,
	type EffectCallback,
	type EventSlot,
	isTemplateResult,
	type NodePath,
	type PropSlot,
	type Slot,
	type TemplateResult,
	type TextSlot,
} from "./types.js";
import { guardUrlAttribute, guardUrlProperty } from "./urlGuard.js";

export type { Disposer };

/**
 * The `onMount` hooks collected while a tree is built, and whether they have
 * already been run.
 *
 * A bare array was not enough. The root flushes it once, after the fragment is
 * in the document; a reactive slot that swapped its content LATER kept
 * appending to that same array, and nothing flushed it again — the component's
 * setup ran, its `onMount` never did, and the hooks piled up for the life of
 * the page. The flag is what lets a later update tell "collect these, the root
 * will run them" from "the root is done, run mine myself".
 */
export interface MountQueue {
	hooks: Array<EffectCallback>;
	flushed: boolean;
}

/**
 * Run hooks, sending any teardown to `cleanups`.
 *
 * Failures are swallowed per hook: one component's bad `onMount` must not stop
 * its siblings from mounting.
 */
export function runMountHooks(
	hooks: Array<EffectCallback>,
	cleanups: Disposer[],
): void {
	// The hooks' effects end with the component: an effect an `onMount`
	// created had no owner, and went on running after the component that made
	// it was unmounted.
	const previous = setOwner(cleanups);
	try {
		for (const hook of hooks) {
			try {
				const teardown = hook();
				if (typeof teardown === "function") cleanups.push(teardown);
			} catch {
				/* swallow — one bad onMount should not block sibling components */
			}
		}
	} finally {
		setOwner(previous);
	}
}

/**
 * Mount a TemplateResult into `container`. Returns a `Disposer` that
 * stops every reactive effect and removes the mounted nodes. Calling it
 * twice is a no-op.
 */
export function render(
	result: TemplateResult,
	container: Element | DocumentFragment,
): Disposer {
	const cleanups: Disposer[] = [];
	const queue: MountQueue = { hooks: [], flushed: false };

	// Untracked, hooks included: a root is its own even when an effect renders
	// it. An overlay renders its content into a portal from the effect that
	// follows its open state, and what the content read while it was built, or
	// when it mounted, re-ran that effect.
	//
	// Unowned for the same reason: an effect ends what its run created when it
	// runs again, and an overlay that keeps its content open across re-runs of
	// that effect would find it frozen. Only the disposer below ends a root.
	const mountedNodes = untrack(() => {
		const previousOwner = setOwner(undefined);
		let built: Mounted;
		try {
			built = mount(result, cleanups, queue);
		} finally {
			setOwner(previousOwner);
		}
		const { fragment, owned } = built;
		container.appendChild(fragment);

		// `onMount` hooks fire after the fragment is live in the document so
		// callbacks that measure / focus / observe see a real DOM. A returned
		// cleanup function joins the unmount queue.
		runMountHooks(queue.hooks, cleanups);
		queue.hooks = [];
		// From here on the root never flushes again, so a slot that mounts
		// something later has to run its own hooks.
		queue.flushed = true;
		return owned;
	});

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		// Untracked too: the effect that rendered a root usually disposes it at
		// the start of its next run, and what an `onUnmount` or an `onMount`'s
		// teardown read there subscribed that effect.
		untrack(() => {
			for (const c of cleanups.splice(0)) c();
		});
		for (const node of mountedNodes.splice(0)) node.remove();
	};
}

/**
 * Pending multi-slot attribute group — collected during the per-slot
 * pass so the renderer can wire a single effect per `(element, attr)`
 * after every contributing value is known.
 */
interface MultiAttrGroup {
	el: Element;
	name: string;
	staticParts: readonly string[];
	/** Source-ordered values from each contributing slot. */
	values: unknown[];
}

/**
 * A template built into a fragment, and the nodes of that fragment it owns.
 *
 * It owns its template's own top-level nodes — static content and the anchors
 * of its slots — and nothing a slot put in front of an anchor. What a slot
 * shows is the slot's: it removes it when it changes or is disposed. Keeping
 * it here as well held it in memory after the slot had replaced it: a list
 * the root kept for the life of the page held every page a slot had shown.
 */
export interface Mounted {
	fragment: DocumentFragment;
	owned: ChildNode[];
}

/**
 * Build a fragment for a TemplateResult and register cleanups.
 *
 * @internal Exported so `hydrate.ts` can client-render a reactive
 * nested-template subtree when the signal changes after hydration
 * (the swap path — see `hydrateTextSlot`).
 */
export function mount(
	result: TemplateResult,
	cleanups: Disposer[],
	queue: MountQueue,
): Mounted {
	const tpl = getTemplate(result.strings);
	const fragment = tpl.element.content.cloneNode(true);
	if (!isFragmentNode(fragment)) {
		throw new E_AURORA_INTERNAL([
			"render: cloning a template's content did not give a fragment",
		]);
	}
	// Before any slot puts its content in.
	const owned = Array.from(fragment.childNodes);

	// Forward any component()-attached lifecycle from this result.
	const lifecycle = readComponentLifecycle(result);
	if (lifecycle) {
		for (const hook of lifecycle.mountHooks) queue.hooks.push(hook);
		for (const c of lifecycle.cleanups) cleanups.push(c);
	}

	// Multi-slot attrs need every contributing value before we can join
	// the final string. Collect them in a first pass, attach effects
	// after.
	const multiGroups = new Map<string, MultiAttrGroup>();

	// Resolve EVERY slot's node before applying any of them. Applying a text
	// slot inserts nodes into the fragment, which shifts the child indices the
	// remaining paths were computed against — so a slot sitting after a nested
	// template (`${Icon()}${label}`) used to resolve to the wrong node, or to
	// none, and silently never bound. Fragments exist precisely so a component
	// needs no wrapper element; they must not cost the slots that follow them.
	const resolved: Array<Node | null> = tpl.slots.map((slot) =>
		resolvePath(fragment, slot.path),
	);

	for (const [i, slot] of tpl.slots.entries()) {
		const node = resolved[i];
		if (node === null || node === undefined) {
			// Path didn't resolve — skip this binding rather than crash (see
			// resolvePath). Degrades to a dead binding; the surrounding render
			// (and any command driving it) survives.
			if (typeof console !== "undefined") {
				console.warn(
					`[aurora] render: slot ${i} (${slot.kind}) path ${slot.path.join(".")} did not resolve — skipping binding`,
				);
			}
			continue;
		}
		// Type guard: an attr/bool/prop/event slot needs an Element. On a
		// structural desync the path can land on an EXISTING node of the wrong
		// type (Text/Comment) — casting it to Element and calling setAttribute
		// would throw "setAttribute is not a function". Degrade like the null
		// case (skip the binding) instead of crashing the whole render.
		if (slot.kind === "text") {
			// A text slot is anchored on the marker comment the template put there.
			if (!isCommentNode(node)) {
				if (typeof console !== "undefined") {
					console.warn(
						`[aurora] render: slot ${i} (text) path ${slot.path.join(".")} resolved to a node that is not its marker — skipping binding`,
					);
				}
				continue;
			}
			applyTextSlot(
				slot,
				node,
				bindTemplateContext(result, result.values[i]),
				cleanups,
				queue,
			);
			continue;
		}
		if (!isElementNode(node)) {
			if (typeof console !== "undefined") {
				console.warn(
					`[aurora] render: slot ${i} (${slot.kind}) path ${slot.path.join(".")} resolved to a non-element node — skipping binding`,
				);
			}
			continue;
		}
		if (slot.kind === "attr" && slot.staticParts !== undefined) {
			collectMultiAttr(slot, node, result.values[i], multiGroups);
		} else {
			applyElementSlot(slot, node, result.values[i], cleanups);
		}
	}

	for (const group of multiGroups.values()) {
		applyMultiAttrGroup(group, cleanups);
	}

	return { fragment, owned };
}

function resolvePath(root: ParentNode, path: NodePath): Node | null {
	let node: Node = root;
	for (const i of path) {
		const next = node.childNodes[i];
		// Fail-soft: a path step that runs off the live child list means the
		// tree diverged from the parsed template (a hydration desync). Return
		// null so the caller skips the binding instead of dereferencing
		// `undefined.childNodes` and crashing the whole render — which, when the
		// render runs inside a command's onSuccess, used to masquerade as a
		// task failure (and on a guarded page, a logout). Mirrors
		// `resolvePathLive` in hydrate.ts.
		if (next === undefined) return null;
		node = next;
	}
	return node;
}

function applyElementSlot(
	slot: Exclude<Slot, TextSlot>,
	node: Element,
	value: unknown,
	cleanups: Disposer[],
): void {
	switch (slot.kind) {
		case "attr":
			applyAttrSlot(slot, node, value, cleanups);
			return;
		case "boolean-attr":
			applyBooleanAttrSlot(slot, node, value, cleanups);
			return;
		case "prop":
			applyPropSlot(slot, node, value, cleanups);
			return;
		case "event":
			applyEventSlot(slot, node, value, cleanups);
			return;
	}
}

/**
 * Text slot — replace the marker comment with whatever the value
 * resolves to. The anchor comment stays in place; new content is
 * inserted before it, and each re-render swaps out only the nodes it
 * previously inserted.
 *
 * A slot removes what it shows when it is disposed, as well as when it
 * changes. It keeps only the nodes it owns (see {@link Mounted}): what a slot
 * nested in its content shows belongs to that slot, which is disposed first
 * and removes it — and which may have replaced it since.
 */
function applyTextSlot(
	_slot: TextSlot,
	anchor: Comment,
	value: unknown,
	cleanups: Disposer[],
	queue: MountQueue,
): void {
	const list = readEach(value);
	if (list !== undefined) {
		bindEach(list, anchor, cleanups, queue, {
			build: (rowValue, rowCleanups, rowQueue) =>
				renderValueIntoNodes(rowValue, rowCleanups, rowQueue).nodes,
			ownsNodes: true,
		});
		return;
	}
	let currentNodes: ChildNode[] = [];
	/** What the slot shows now, to leave it alone when the next value renders the same. */
	let shown: { value: unknown } | undefined;
	/** The text node it shows, when what it shows is one scalar: updated in place. */
	let text: Text | undefined;
	// Per-render disposers for whatever the slot currently shows. A
	// reactive slot that swaps a nested TemplateResult for another must
	// dispose the OLD subtree's effects + event listeners — otherwise
	// they'd live in the shared `cleanups` array until the whole root
	// disposes, leaking a stale subscription/listener on every branch
	// change. We hand `localCleanups` (not `cleanups`) to the per-render
	// mount and tear it down at the top of each `set()`.
	let localCleanups: Disposer[] = [];

	function disposeLocal(): void {
		for (const d of localCleanups) d();
		localCleanups = [];
	}

	function removeCurrent(): void {
		for (const n of currentNodes) n.remove();
		currentNodes = [];
	}

	function set(newValue: unknown): void {
		const rerun = shown !== undefined;
		// An effect re-runs when anything it read changed, not only when its
		// result did: a value that renders exactly as the one shown is left
		// alone, its nodes, focus and state included.
		if (shown !== undefined && sameContent(shown.value, newValue)) return;
		shown = { value: newValue };
		if (rerun) {
			probe.emit?.({
				kind: "slot",
				target: anchor.parentElement ?? undefined,
				hint: Array.isArray(newValue) ? ARRAY_HINT : undefined,
			});
		}
		if (text !== undefined && isScalar(newValue)) {
			text.data = String(newValue);
			return;
		}
		text = undefined;
		disposeLocal();
		removeCurrent();
		// This render's hooks are collected apart from the shared queue,
		// whichever phase we are in, because their TEARDOWNS belong to this
		// slot: the next swap must dispose what it replaces. Left on the root's
		// list, a component mounted per row kept its subscription until the
		// whole page unmounted.
		//
		// Never flushed while it is being built, even long after the root's
		// flush: the content sits in a detached fragment until the insertion
		// below. Inheriting `flushed = true` there made a slot NESTED in the new
		// content run its components' `onMount` at once, before any of it was in
		// the document — `querySelector` found nothing, a measurement read 0.
		// Deferred to this queue instead, they run after the insertion.
		const own: MountQueue = { hooks: [], flushed: false };
		const { nodes, owned } = renderValueIntoNodes(newValue, localCleanups, own);
		const parent = anchor.parentNode;
		if (!parent) return;
		for (const n of nodes) parent.insertBefore(n, anchor);
		currentNodes = owned;
		const only = owned[0];
		if (owned.length === 1 && isScalar(newValue) && only instanceof Text) {
			text = only;
		}
		if (queue.flushed) {
			// After insertion, exactly as at the root: an `onMount` that
			// measures, focuses or observes has to see a live node. Marked
			// first, so a slot nested here that swaps later runs its own hooks.
			own.flushed = true;
			runMountHooks(own.hooks.splice(0), localCleanups);
			return;
		}
		// Still building the initial tree: the nodes are in a detached
		// fragment, so defer to the root's flush. One wrapper carries them, and
		// it returns nothing — the real teardowns go to `localCleanups`, not to
		// the root.
		//
		// The wrapper also marks this render's queue flushed. A slot nested in
		// it holds that queue, and when it swaps its content later it has to
		// know the flush already happened — left `false`, its hooks were pushed
		// onto a list nobody would drain again, and a component it built never
		// ran its `onMount`.
		const pending = own.hooks;
		queue.hooks.push(() => {
			own.flushed = true;
			runMountHooks(pending.splice(0), localCleanups);
		});
	}

	if (isSignal(value) || typeof value === "function") {
		const dispose = effect(() => {
			// Only the accessor is a dependency of the slot. What showing its
			// value reads — the `onMount` of what it swapped in — belongs to that
			// component, as a list's rows own theirs (see `bindEach`): tracked
			// here, it rebuilt everything the slot held each time it changed.
			const next = readValue(value);
			untrack(() => set(next));
		});
		// Root disposal tears down the slot's own effect AND whatever
		// subtree is currently mounted.
		cleanups.push(() => {
			dispose();
			disposeLocal();
			removeCurrent();
		});
	} else {
		set(value);
		// Static value never re-runs, but its subtree (e.g. a one-shot
		// nested template) still needs to be disposed with the root.
		cleanups.push(() => {
			disposeLocal();
			removeCurrent();
		});
	}
}

/** One row of a keyed list: the accessors it was built with, and its teardowns. */
interface ListRow {
	item: Signal<unknown>;
	index: Signal<number>;
	cleanups: Disposer[];
}

/** A row as hydration adopts it, with the server's nodes it starts from. */
export interface EachRow extends ListRow {
	nodes: ChildNode[];
}

/**
 * A row in place in its list, behind the marker its nodes start at. It keeps
 * no node list: one would hold on to nodes its content has replaced since.
 */
interface PlacedRow extends ListRow {
	start: Comment;
}

/**
 * @internal Keep a keyed list's rows in front of `end`, one per key.
 *
 * A row whose key stays keeps its nodes and its effects: it is handed the new
 * element and position through its accessors and moved if the order changed.
 * A new key builds a row; a key that left disposes its row and removes it.
 *
 * Each row starts at an empty comment, and its nodes run to the next row's
 * marker or to `end`. The nodes a row was built with are not enough: what it
 * renders can add nodes at its top level later — a nested list that grows,
 * a slot at its head that swaps — and moving the row has to take them along.
 *
 * `build` turns a row's rendered value into nodes — the renderer and the
 * hydrator each pass their own. `adopt` is hydration's: on the first run it
 * returns the rows already wired to the server's nodes, in order, instead of
 * building any. `ownsNodes` removes the rows when the list is disposed, as a
 * client-rendered slot removes what it shows; a hydrated tree leaves the
 * server's nodes where they are.
 */
export interface EachBinding {
	build: (
		value: unknown,
		cleanups: Disposer[],
		queue: MountQueue,
	) => ChildNode[];
	/**
	 * Hydration's: the rows the server rendered for `items`, built with
	 * `list` (a lazy list hands its window's), leaving out the nodes in `skip`
	 * (its spacers).
	 */
	adopt?: (
		items: readonly unknown[],
		list: EachList,
		skip: ReadonlySet<Node>,
	) => EachRow[];
	ownsNodes?: boolean;
	/** Told the rows in order, by key with their markers, after each update. */
	placed?: (rows: Array<[unknown, Comment]>) => void;
}

export function bindEach(
	list: EachList,
	end: Node,
	cleanups: Disposer[],
	queue: MountQueue,
	options: EachBinding,
): void {
	if (list.lazy !== undefined) {
		bindLazy(list, list.lazy, end, cleanups, queue, options);
		return;
	}
	const { build, ownsNodes, placed } = options;
	// Dropped once used: it holds the server's nodes, which must not outlive
	// the rows that replace them.
	let adopt = options.adopt;
	const doc = end.ownerDocument ?? document;
	let rows = new Map<unknown, PlacedRow>();
	/** Every row's marker: where one row's nodes stop and the next one's begin. */
	const starts = new Set<Node>();
	let adopting = adopt !== undefined;

	/** A row's nodes as they stand now, its marker first. */
	function nodesOf(row: PlacedRow): ChildNode[] {
		const out: ChildNode[] = [row.start];
		for (
			let n = row.start.nextSibling;
			n !== null && n !== end && !starts.has(n);
			n = n.nextSibling
		) {
			out.push(n);
		}
		return out;
	}

	function place(row: ListRow, start: Comment): PlacedRow {
		starts.add(start);
		return { item: row.item, index: row.index, cleanups: row.cleanups, start };
	}

	/** Mark the adopted rows where the server put them. */
	function placeAdopted(adopted: EachRow[]): PlacedRow[] {
		const placed: PlacedRow[] = [];
		const parent = end.parentNode;
		let before: Node = end;
		for (let r = adopted.length - 1; r >= 0; r--) {
			const row = adopted[r];
			if (row === undefined) continue;
			const start = doc.createComment("");
			const head = row.nodes[0] ?? before;
			(head.parentNode ?? parent)?.insertBefore(start, head);
			placed.unshift(place(row, start));
			before = start;
		}
		return placed;
	}

	function update(items: readonly unknown[]): void {
		const keys = items.map((item, index) => list.key(item, index));
		if (new Set(keys).size !== keys.length) {
			const duplicate = keys.find((key, i) => keys.indexOf(key) !== i);
			throw new E_AURORA_DUPLICATE_KEY([String(duplicate)]);
		}
		if (adopting && adopt !== undefined) {
			adopting = false;
			const adopted = placeAdopted(adopt(items, list, new Set()));
			adopt = undefined;
			rows = new Map();
			for (const [i, row] of adopted.entries()) rows.set(keys[i], row);
			placed?.(adopted.map((row, i) => [keys[i], row.start]));
			return;
		}
		adopting = false;
		probe.emit?.({ kind: "list", target: end.parentElement ?? undefined });

		const next = new Map<unknown, PlacedRow>();
		const built: Array<{ row: PlacedRow; hooks: MountQueue }> = [];
		for (const [i, item] of items.entries()) {
			const key = keys[i];
			const kept = rows.get(key);
			if (kept !== undefined) {
				kept.item(item);
				kept.index(i);
				next.set(key, kept);
				continue;
			}
			const fresh: ListRow = {
				item: signal(item),
				index: signal(i),
				cleanups: [],
			};
			// A row's hooks are its own, like a swapped slot's: their teardowns
			// go when the row goes, not when the page does. Not flushed while it
			// is built: the row sits in a fragment until it is placed below, and
			// a slot nested in it must wait for that (see `set()` in applyTextSlot).
			const hooks: MountQueue = { hooks: [], flushed: false };
			const nodes = ownedBy(fresh.cleanups, () =>
				list.run(() =>
					build(list.render(fresh.item, fresh.index), fresh.cleanups, hooks),
				),
			);
			// Held in a fragment until it is placed, so its nodes read the same
			// way as a placed row's.
			const start = doc.createComment("");
			doc.createDocumentFragment().append(start, ...nodes);
			const row = place(fresh, start);
			next.set(key, row);
			built.push({ row, hooks });
		}
		for (const [key, row] of rows) {
			if (next.has(key)) continue;
			disposeRow(row);
			for (const n of nodesOf(row)) n.remove();
			starts.delete(row.start);
		}
		rows = next;

		// Walk from the end so each row only has to sit right before the one
		// after it: a row already there is left alone, so a list that kept its
		// order moves nothing, and a row that moved is moved once.
		const parent = end.parentNode;
		if (parent === null) return;
		let before: Node = end;
		const ordered = [...next.values()];
		for (let r = ordered.length - 1; r >= 0; r--) {
			const row = ordered[r];
			if (row === undefined) continue;
			const nodes = nodesOf(row);
			const last = nodes[nodes.length - 1];
			if (last?.parentNode !== parent || last.nextSibling !== before) {
				for (const n of nodes) parent.insertBefore(n, before);
			}
			before = row.start;
		}

		placed?.(ordered.map((row, i) => [keys[i], row.start]));

		for (const { row, hooks } of built) {
			if (queue.flushed) {
				hooks.flushed = true;
				runMountHooks(hooks.hooks.splice(0), row.cleanups);
				continue;
			}
			// Still building the initial tree: the root's flush runs them.
			const pending = hooks.hooks;
			queue.hooks.push(() => {
				hooks.flushed = true;
				runMountHooks(pending.splice(0), row.cleanups);
			});
		}
	}

	const dispose = effect(() => {
		const items = readEachItems(list.items);
		// Only the array is a dependency of the list. What a row reads while it
		// is built — a component's setup reading a prop — belongs to the row.
		untrack(() => update(items));
	});
	cleanups.push(() => {
		dispose();
		for (const row of rows.values()) {
			disposeRow(row);
			if (ownsNodes === true) for (const n of nodesOf(row)) n.remove();
		}
		rows = new Map();
		starts.clear();
	});
}

const LAZY_ATTRIBUTE = "data-aurora-lazy";

/** A lazy list's spacer: an empty block the rows not built stand behind. */
function makeSpacer(doc: Document, side: "before" | "after"): HTMLElement {
	const spacer = doc.createElement("div");
	spacer.setAttribute(LAZY_ATTRIBUTE, side);
	spacer.setAttribute("aria-hidden", "true");
	sizeSpacer(spacer, 0);
	return spacer;
}

/** Hidden when empty: a gap-separated container would give it a gap. */
function sizeSpacer(spacer: HTMLElement, height: number): void {
	spacer.style.overflowAnchor = "none";
	if (height > 0) {
		spacer.style.display = "";
		spacer.style.height = `${height}px`;
	} else {
		spacer.style.display = "none";
		spacer.style.height = "0px";
	}
}

/** The spacers the server rendered at the head and tail of a lazy list's range. */
function serverSpacers(
	end: Node,
): { before: HTMLElement; after: HTMLElement } | undefined {
	let after: HTMLElement | undefined;
	for (let n = end.previousSibling; n !== null; n = n.previousSibling) {
		if (!(n instanceof HTMLElement)) continue;
		const side = n.getAttribute(LAZY_ATTRIBUTE);
		if (after === undefined) {
			if (side !== "after") return undefined;
			after = n;
		} else if (side === "before") {
			return { before: n, after };
		}
	}
	return undefined;
}

/** The nearest ancestor that scrolls vertically, or null for the page. */
function scrollParent(from: Element): HTMLElement | null {
	for (let el = from.parentElement; el !== null; el = el.parentElement) {
		if (el === el.ownerDocument.body || el === el.ownerDocument.documentElement)
			return null;
		const overflow = getComputedStyle(el).overflowY;
		if (overflow === "auto" || overflow === "scroll" || overflow === "overlay")
			return el;
	}
	return null;
}

/** Run `hook` once the list's nodes are in the document. */
function whenMounted(
	queue: MountQueue,
	cleanups: Disposer[],
	hook: () => Disposer | undefined,
): void {
	if (queue.flushed) {
		runMountHooks([hook], cleanups);
		return;
	}
	queue.hooks.push(hook);
}

/**
 * @internal A lazy list on the DOM: only the rows intersecting its scroll
 * viewport (plus `overscan`) exist, between two spacers that stand for the
 * others at their measured heights, or the estimate for a row never shown.
 *
 * The rows it builds are an ordinary keyed list over its window, so a row
 * that stays in view keeps its nodes. After each scroll or resize, once per
 * frame, it measures the rows it shows, picks the window again and, when a
 * measure corrected an estimate above the viewport, scrolls by the
 * difference so what was on screen stays put. With `from: "end"` it starts at
 * the bottom and stays there while rows arrive, unless the reader scrolled up.
 *
 * The first window is the one the server rendered (see `firstWindow`), so a
 * hydrated list adopts the server's rows and spacers before it measures.
 */
function bindLazy(
	list: EachList,
	lazy: LazyList,
	end: Node,
	cleanups: Disposer[],
	queue: MountQueue,
	options: EachBinding,
): void {
	const doc = end.ownerDocument ?? document;
	const adopted = options.adopt !== undefined ? serverSpacers(end) : undefined;
	const before = adopted?.before ?? makeSpacer(doc, "before");
	const after = adopted?.after ?? makeSpacer(doc, "after");
	if (adopted === undefined) {
		end.parentNode?.insertBefore(before, end);
		end.parentNode?.insertBefore(after, end);
	}
	if (options.ownsNodes === true) {
		cleanups.push(() => {
			before.remove();
			after.remove();
		});
	}

	const layout = new LazyLayout(lazy);
	const view = signal<LazyView | null>(null);
	const measured = signal(0);
	let placed: Array<[unknown, Comment]> = [];

	const { keys, win, start } = ownedBy(cleanups, () => {
		const keys = memo(() => {
			const all = readEachItems(list.items).map((item, index) =>
				list.key(item, index),
			);
			if (new Set(all).size !== all.length) {
				const duplicate = all.find((key, i) => all.indexOf(key) !== i);
				throw new E_AURORA_DUPLICATE_KEY([String(duplicate)]);
			}
			return all;
		});
		const win = memo(
			() => {
				const all = keys();
				measured();
				const current = view();
				layout.keep(all);
				if (current === null) {
					const [first, last] = firstWindow(all.length, lazy);
					return layout.spacers(all, first, last);
				}
				return layout.window(all, current);
			},
			{ equals: sameWindow },
		);
		const start = memo(() => win().start);
		effect(() => {
			const w = win();
			sizeSpacer(before, w.before);
			sizeSpacer(after, w.after);
		});
		return { keys, win, start };
	});

	// The rows: a keyed list over the window, whose rows see their position
	// in the whole list.
	const windowList: EachList = {
		items: () => {
			const w = win();
			return readEachItems(list.items).slice(w.start, w.end);
		},
		key: (item, index) => list.key(item, index + untrack(start)),
		render: (item, index) =>
			list.render(
				item,
				memo(() => index() + start()),
			),
		run: list.run,
	};
	const adopt = options.adopt;
	bindEach(windowList, after, cleanups, queue, {
		build: options.build,
		ownsNodes: options.ownsNodes,
		adopt:
			adopt === undefined
				? undefined
				: (items, rows) => adopt(items, rows, new Set([before, after])),
		placed: (rows) => {
			placed = rows;
		},
	});

	if (
		typeof requestAnimationFrame !== "function" ||
		typeof getComputedStyle !== "function"
	) {
		return;
	}
	whenMounted(queue, cleanups, () => {
		const parent = before.parentElement;
		if (parent === null) return undefined;
		const scroller = scrollParent(before);
		const page = doc.scrollingElement ?? doc.documentElement;
		const box = scroller ?? page;
		let frame = 0;
		let pinned = lazy.from === "end";
		let started = false;

		const viewport = () => {
			if (scroller === null) return { top: 0, height: window.innerHeight };
			const rect = scroller.getBoundingClientRect();
			return {
				top: rect.top + scroller.clientTop,
				height: scroller.clientHeight,
			};
		};
		const atEnd = () =>
			box.scrollTop + (scroller?.clientHeight ?? window.innerHeight) >=
			box.scrollHeight - 2;
		const toEnd = () => {
			box.scrollTop = box.scrollHeight;
		};
		const shown = (el: HTMLElement) => el.style.display !== "none";

		/** Where each shown row starts, in viewport coordinates, and where the last ends. */
		const tops = (): { rows: Array<[unknown, number]>; bottom: number } => {
			const range = doc.createRange();
			const rows: Array<[unknown, number]> = [];
			let bottom = Number.NaN;
			for (const [i, [key, marker]] of placed.entries()) {
				const next = placed[i + 1]?.[1] ?? after;
				if (marker.parentNode === null || next.parentNode !== marker.parentNode)
					continue;
				range.setStartAfter(marker);
				range.setEndBefore(next);
				const rect = range.getBoundingClientRect();
				if (rect.width === 0 && rect.height === 0) continue;
				rows.push([key, rect.top]);
				bottom = rect.bottom;
			}
			if (shown(after)) bottom = after.getBoundingClientRect().top;
			return { rows, bottom };
		};

		const refresh = () => {
			frame = 0;
			const { rows, bottom } = tops();
			// Heights from one row's top to the next: gaps and margins included.
			let changed = false;
			for (const [i, [key, top]] of rows.entries()) {
				const next = rows[i + 1]?.[1] ?? bottom;
				if (Number.isFinite(next) && layout.measure(key, next - top))
					changed = true;
			}
			const port = viewport();
			const anchor = rows.find(
				([, top], i) =>
					(rows[i + 1]?.[1] ?? bottom) > port.top &&
					top <= port.top + port.height,
			);
			const listTop = shown(before)
				? before.getBoundingClientRect().top
				: (rows[0]?.[1] ?? after.getBoundingClientRect().top);
			const was = untrack(win);
			batch(() => {
				if (changed) measured((n) => n + 1);
				view(
					pinned
						? { kind: "end", height: port.height }
						: {
								kind: "span",
								from: port.top - listTop,
								to: port.top - listTop + port.height,
							},
				);
			});
			if (pinned) {
				toEnd();
			} else if (anchor !== undefined) {
				// Keep what was on screen where it was: an estimate corrected
				// above it moved it.
				const now = tops().rows.find(([key]) => Object.is(key, anchor[0]));
				if (now !== undefined && Math.abs(now[1] - anchor[1]) > 0.5)
					box.scrollTop += now[1] - anchor[1];
			}
			if (changed || !sameWindow(was, untrack(win))) schedule();
		};
		const schedule = () => {
			if (frame === 0) frame = requestAnimationFrame(refresh);
		};
		const onScroll = () => {
			if (started && lazy.from === "end") pinned = atEnd();
			schedule();
		};

		const target: EventTarget = scroller ?? window;
		target.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", schedule);
		const resized =
			typeof ResizeObserver === "function"
				? new ResizeObserver(schedule)
				: null;
		resized?.observe(parent);
		if (scroller !== null) resized?.observe(scroller);
		// A new array: pick the window again (and follow the end if pinned).
		const stopItems = effect(() => {
			keys();
			untrack(schedule);
		});
		refresh();
		started = true;
		return () => {
			stopItems();
			target.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", schedule);
			resized?.disconnect();
			if (frame !== 0) cancelAnimationFrame(frame);
		};
	});
}

/**
 * @internal A keyed list an accessor returned, as nodes: its rows and an
 * anchor of its own to keep them in front of, which the list removes with
 * itself.
 */
export function eachNodes(
	list: EachList,
	cleanups: Disposer[],
	queue: MountQueue,
	doc: Document,
	build: (
		value: unknown,
		cleanups: Disposer[],
		queue: MountQueue,
	) => ChildNode[],
): ChildNode[] {
	const holder = doc.createDocumentFragment();
	const end = doc.createComment("");
	holder.append(end);
	bindEach(list, end, cleanups, queue, { build, ownsNodes: true });
	cleanups.push(() => end.remove());
	return Array.from(holder.childNodes);
}

/**
 * @internal Run `fn` with a reactive owner that ends with `cleanups`.
 *
 * A list builds its rows inside its own effect, and an effect ends what its
 * run created when it runs again: a kept row would have lost its effects at
 * the next change of the array. A row is its own owner instead, and goes
 * when the row goes.
 */
export function ownedBy<T>(cleanups: Disposer[], fn: () => T): T {
	const owned: Disposer[] = [];
	cleanups.push(() => {
		for (const end of owned.splice(0)) end();
	});
	const previous = setOwner(owned);
	try {
		return fn();
	} finally {
		setOwner(previous);
	}
}

function disposeRow(row: ListRow): void {
	for (const d of row.cleanups.splice(0)) d();
}

/** A value built into nodes: those to insert, and those the caller owns (see {@link Mounted}). */
interface Rendered {
	nodes: ChildNode[];
	owned: ChildNode[];
}

/** What the re-render counter says when a slot rebuilt an array. */
const ARRAY_HINT =
	"a slot rebuilt a whole array: each(items, key, render) keeps the rows whose key stays";

/** A value a text slot shows as one text node. */
function isScalar(value: unknown): value is string | number | bigint | true {
	return (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		value === true
	);
}

function rendersNothing(value: unknown): boolean {
	return value === null || value === undefined || value === false;
}

/**
 * @internal Whether a text slot showing `a` would show exactly the same
 * nodes for `b`: the same scalar text, nothing for both, or templates from
 * the same call site whose values are the same, all the way down.
 *
 * Function values compare by identity — what a new closure would do cannot
 * be known without running it — and a component's template never compares
 * equal: its setup already ran for the new one.
 */
export function sameContent(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (rendersNothing(a) && rendersNothing(b)) return true;
	if (isScalar(a) && isScalar(b)) return String(a) === String(b);
	if (Array.isArray(a) && Array.isArray(b)) {
		return (
			a.length === b.length && a.every((item, i) => sameContent(item, b[i]))
		);
	}
	if (isTemplateResult(a) && isTemplateResult(b)) {
		if (a.strings !== b.strings || a.values.length !== b.values.length) {
			return false;
		}
		if (
			readComponentLifecycle(a) !== undefined ||
			readComponentLifecycle(b) !== undefined
		) {
			return false;
		}
		return a.values.every((value, i) => sameSlotValue(value, b.values[i]));
	}
	return false;
}

/**
 * Inside a template, a value may sit in an attribute or a property, where
 * `1` and `"1"` or `null` and `false` are not interchangeable: only nested
 * templates and arrays are compared by what they render.
 */
function sameSlotValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (
		(isTemplateResult(a) && isTemplateResult(b)) ||
		(Array.isArray(a) && Array.isArray(b))
	) {
		return sameContent(a, b);
	}
	return false;
}

function renderValueIntoNodes(
	value: unknown,
	cleanups: Disposer[],
	queue: MountQueue,
): Rendered {
	if (value === null || value === undefined || value === false) {
		return { nodes: [], owned: [] };
	}
	const list = readEach(value);
	if (list !== undefined) {
		// The rows are the list's, which removes them with itself.
		const nodes = eachNodes(
			list,
			cleanups,
			queue,
			document,
			(v, c, q) => renderValueIntoNodes(v, c, q).nodes,
		);
		return { nodes, owned: [] };
	}
	if (Array.isArray(value)) {
		const out: Rendered = { nodes: [], owned: [] };
		for (const item of value) {
			const part = renderValueIntoNodes(item, cleanups, queue);
			out.nodes.push(...part.nodes);
			out.owned.push(...part.owned);
		}
		return out;
	}
	if (isTemplateResult(value)) {
		const { fragment, owned } = mount(value, cleanups, queue);
		return { nodes: Array.from(fragment.childNodes), owned };
	}
	if (value instanceof Node) {
		if (isChildNode(value)) return { nodes: [value], owned: [value] };
		// A fragment is its children: inserting one empties it, so a range that
		// held the fragment would hold nothing.
		const nodes = Array.from(value.childNodes);
		return { nodes, owned: [...nodes] };
	}
	const node = document.createTextNode(String(value));
	return { nodes: [node], owned: [node] };
}

/**
 * @internal Give `el` the attribute a slot's value asks for, unless it holds
 * it already. A binding re-runs whenever anything it read changed; rewriting
 * an identical value still fires every MutationObserver and restarts CSS
 * transitions keyed on the attribute, and on hydration rewrote what the
 * server had just written. Says whether it wrote.
 */
export function writeAttribute(el: Element, name: string, v: unknown): boolean {
	assertNotMarkup(v);
	if (v === null || v === undefined || v === false) {
		if (!el.hasAttribute(name)) return false;
		el.removeAttribute(name);
		return true;
	}
	const next =
		v === true ? "" : guardUrlAttribute(el.localName, name, String(v));
	if (el.getAttribute(name) === next) return false;
	el.setAttribute(name, next);
	return true;
}

/** @internal {@link writeAttribute} for a `?name=` slot: present when truthy. */
export function writeBooleanAttribute(
	el: Element,
	name: string,
	v: unknown,
): boolean {
	if (Boolean(v) === el.hasAttribute(name)) return false;
	if (v) el.setAttribute(name, "");
	else el.removeAttribute(name);
	return true;
}

/**
 * @internal Follow a reactive element binding: `write` what `read` returns on
 * every run, and tell the re-render counter when a later run wrote something.
 */
export function bindElementEffect(
	el: Element,
	kind: "attribute" | "property",
	name: string,
	read: () => unknown,
	write: (v: unknown) => boolean,
	cleanups: Disposer[],
): void {
	let first = true;
	cleanups.push(
		effect(() => {
			const wrote = write(read());
			if (!first && wrote) probe.emit?.({ kind, target: el, name });
			first = false;
		}),
	);
}

/**
 * @internal A `.prop` writer that skips a value equal to the one it wrote
 * last. Compared with what it wrote, not with what the element holds: a
 * `.value` the user typed over is the user's until the bound value changes,
 * and a re-run caused by something else put the old value back over it.
 */
export function propertyWriter(
	el: Element,
	name: string,
): (v: unknown) => boolean {
	let last: { value: unknown } | undefined;
	return (v) => {
		assertPropertyValue(el, name, v);
		const next = guardUrlProperty(el.localName, name, v);
		if (last !== undefined && Object.is(last.value, next)) return false;
		last = { value: next };
		// Reflect.set writes the property without a cast.
		Reflect.set(el, name, next);
		return true;
	};
}

/**
 * `motion=${…}` and `scroll-y=${value}` are bindings, not attributes: they
 * drive the element's style from motion values (see motionDom.ts).
 */
export function bindsMotion(
	slot: AttrSlot,
	el: Element,
	value: unknown,
	cleanups: Disposer[],
): boolean {
	if (slot.staticParts !== undefined) return false;
	if (slot.name === "motion") {
		bindMotionDom(el, value, cleanups);
		return true;
	}
	if (slot.name === "scroll-y") {
		bindScrollDom(el, value, cleanups);
		return true;
	}
	return false;
}

function applyAttrSlot(
	slot: AttrSlot,
	el: Element,
	value: unknown,
	cleanups: Disposer[],
): void {
	if (bindsMotion(slot, el, value, cleanups)) return;
	const write = (v: unknown): boolean => writeAttribute(el, slot.name, v);
	if (isSignal(value) || typeof value === "function") {
		bindElementEffect(
			el,
			"attribute",
			slot.name,
			() => readValue(value),
			write,
			cleanups,
		);
	} else {
		write(value);
	}
}

function collectMultiAttr(
	slot: AttrSlot,
	el: Element,
	value: unknown,
	groups: Map<string, MultiAttrGroup>,
): void {
	if (!slot.staticParts) return;
	const key = `${slot.name}::${slot.path.join(".")}`;
	let group = groups.get(key);
	if (!group) {
		group = {
			el,
			name: slot.name,
			staticParts: slot.staticParts,
			values: [],
		};
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
			const v = readValue(group.values[i]);
			assertNotMarkup(v);
			out += v == null || v === false ? "" : String(v);
			out += group.staticParts[i + 1] ?? "";
		}
		return out;
	}

	const hasReactive = group.values.some(
		(v) => isSignal(v) || typeof v === "function",
	);
	// The guard sees the WHOLE value here — static parts and slots joined — which
	// is what a scheme check needs: it can only be at the start.
	const write = (joined: unknown): boolean => {
		const next = guardUrlAttribute(
			group.el.localName,
			group.name,
			String(joined),
		);
		if (group.el.getAttribute(group.name) === next) return false;
		group.el.setAttribute(group.name, next);
		return true;
	};
	if (hasReactive) {
		bindElementEffect(group.el, "attribute", group.name, join, write, cleanups);
	} else {
		write(join());
	}
}

function applyBooleanAttrSlot(
	slot: BooleanAttrSlot,
	el: Element,
	value: unknown,
	cleanups: Disposer[],
): void {
	const write = (v: unknown): boolean =>
		writeBooleanAttribute(el, slot.name, v);
	if (isSignal(value) || typeof value === "function") {
		bindElementEffect(
			el,
			"attribute",
			slot.name,
			() => readValue(value),
			write,
			cleanups,
		);
	} else {
		write(value);
	}
}

function applyPropSlot(
	slot: PropSlot,
	el: Element,
	value: unknown,
	cleanups: Disposer[],
): void {
	const write = propertyWriter(el, slot.name);
	if (isSignal(value) || typeof value === "function") {
		bindElementEffect(
			el,
			"property",
			slot.name,
			() => readValue(value),
			write,
			cleanups,
		);
	} else {
		write(value);
	}
}

function applyEventSlot(
	slot: EventSlot,
	el: Element,
	value: unknown,
	cleanups: Disposer[],
): void {
	if (typeof value !== "function") return;
	// Called as the DOM calls a listener: `this` is the element it is bound to.
	const handler = (event: Event): void => {
		Reflect.apply(value, event.currentTarget, [event]);
	};
	el.addEventListener(slot.event, handler);
	cleanups.push(() => el.removeEventListener(slot.event, handler));
}
