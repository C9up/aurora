/// <reference lib="dom" />
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

import { bindTemplateContext, readComponentLifecycle } from "./component.js";
import { type EachList, readEach, readEachItems } from "./each.js";
import { AuroraError } from "./errors.js";
import { getTemplate } from "./html.js";
import { effect, isSignal, type Signal, signal, untrack } from "./reactive.js";
import { assertPropertyValue } from "./templateScanner.js";
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
	type TextSlot,
} from "./types.js";
import { guardUrlAttribute, guardUrlProperty } from "./urlGuard.js";

export type Disposer = () => void;

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
	for (const hook of hooks) {
		try {
			const teardown = hook();
			if (typeof teardown === "function") cleanups.push(teardown);
		} catch {
			/* swallow — one bad onMount should not block sibling components */
		}
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

	const { fragment, owned: mountedNodes } = mount(result, cleanups, queue);
	container.appendChild(fragment);

	// `onMount` hooks fire after the fragment is live in the document so
	// callbacks that measure / focus / observe see a real DOM. A returned
	// cleanup function joins the unmount queue.
	runMountHooks(queue.hooks, cleanups);
	queue.hooks = [];
	// From here on the root never flushes again, so a slot that mounts
	// something later has to run its own hooks.
	queue.flushed = true;

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		for (const c of cleanups.splice(0)) c();
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
	const fragment = tpl.element.content.cloneNode(true) as DocumentFragment;
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
		if (slot.kind !== "text" && node.nodeType !== 1) {
			if (typeof console !== "undefined") {
				console.warn(
					`[aurora] render: slot ${i} (${slot.kind}) path ${slot.path.join(".")} resolved to a non-element node — skipping binding`,
				);
			}
			continue;
		}
		if (slot.kind === "attr" && slot.staticParts !== undefined) {
			collectMultiAttr(slot, node as Element, result.values[i], multiGroups);
		} else {
			const value =
				slot.kind === "text"
					? bindTemplateContext(result, result.values[i])
					: result.values[i];
			applySlot(slot, node, value, cleanups, queue);
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

function applySlot(
	slot: Slot,
	node: Node,
	value: unknown,
	cleanups: Disposer[],
	queue: MountQueue,
): void {
	switch (slot.kind) {
		case "text":
			applyTextSlot(slot, node as Comment, value, cleanups, queue);
			return;
		case "attr":
			applyAttrSlot(slot, node as Element, value, cleanups);
			return;
		case "boolean-attr":
			applyBooleanAttrSlot(slot, node as Element, value, cleanups);
			return;
		case "prop":
			applyPropSlot(slot, node as Element, value, cleanups);
			return;
		case "event":
			applyEventSlot(slot, node as Element, value, cleanups);
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
		disposeLocal();
		removeCurrent();
		// This render's hooks are collected apart from the shared queue,
		// whichever phase we are in, because their TEARDOWNS belong to this
		// slot: the next swap must dispose what it replaces. Left on the root's
		// list, a component mounted per row kept its subscription until the
		// whole page unmounted.
		//
		// `flushed` is inherited so a deeper slot built during this render
		// still knows whether the root has a flush coming.
		const own: MountQueue = { hooks: [], flushed: queue.flushed };
		const { nodes, owned } = renderValueIntoNodes(newValue, localCleanups, own);
		const parent = anchor.parentNode;
		if (!parent) return;
		for (const n of nodes) parent.insertBefore(n, anchor);
		currentNodes = owned;
		if (queue.flushed) {
			// After insertion, exactly as at the root: an `onMount` that
			// measures, focuses or observes has to see a live node.
			runMountHooks(own.hooks, localCleanups);
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
			set((value as () => unknown)());
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
export function bindEach(
	list: EachList,
	end: Node,
	cleanups: Disposer[],
	queue: MountQueue,
	options: {
		build: (
			value: unknown,
			cleanups: Disposer[],
			queue: MountQueue,
		) => ChildNode[];
		adopt?: (items: readonly unknown[]) => EachRow[];
		ownsNodes?: boolean;
	},
): void {
	const { build, ownsNodes } = options;
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
			throw new AuroraError(
				"E_AURORA_DUPLICATE_KEY",
				`[aurora] each(): two elements share the key ${String(duplicate)} — a key names one row`,
			);
		}
		if (adopting && adopt !== undefined) {
			adopting = false;
			const adopted = placeAdopted(adopt(items));
			adopt = undefined;
			rows = new Map();
			for (const [i, row] of adopted.entries()) rows.set(keys[i], row);
			return;
		}
		adopting = false;

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
			// go when the row goes, not when the page does.
			const hooks: MountQueue = { hooks: [], flushed: queue.flushed };
			const nodes = list.run(() =>
				build(list.render(fresh.item, fresh.index), fresh.cleanups, hooks),
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

		for (const { row, hooks } of built) {
			if (queue.flushed) {
				runMountHooks(hooks.hooks, row.cleanups);
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

function disposeRow(row: ListRow): void {
	for (const d of row.cleanups.splice(0)) d();
}

/** A value built into nodes: those to insert, and those the caller owns (see {@link Mounted}). */
interface Rendered {
	nodes: ChildNode[];
	owned: ChildNode[];
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
	const node =
		value instanceof Node
			? (value as ChildNode)
			: document.createTextNode(String(value));
	return { nodes: [node], owned: [node] };
}

function applyAttrSlot(
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
			el.setAttribute(
				slot.name,
				guardUrlAttribute(el.localName, slot.name, String(v)),
			);
		}
	}
	if (isSignal(value) || typeof value === "function") {
		const dispose = effect(() => apply((value as () => unknown)()));
		cleanups.push(dispose);
	} else {
		apply(value);
	}
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
			const v = resolveReactive(group.values[i]);
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
	const write = (): void => {
		group.el.setAttribute(
			group.name,
			guardUrlAttribute(group.el.localName, group.name, join()),
		);
	};
	if (hasReactive) {
		cleanups.push(effect(write));
	} else {
		write();
	}
}

function resolveReactive(value: unknown): unknown {
	if (isSignal(value)) return value();
	if (typeof value === "function") return (value as () => unknown)();
	return value;
}

function applyBooleanAttrSlot(
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
	} else {
		apply(value);
	}
}

function applyPropSlot(
	slot: PropSlot,
	el: Element,
	value: unknown,
	cleanups: Disposer[],
): void {
	function apply(v: unknown): void {
		// See hydrate.ts: Reflect.set writes the property without a cast.
		assertPropertyValue(el, slot.name, v);
		Reflect.set(el, slot.name, guardUrlProperty(el.localName, slot.name, v));
	}
	if (isSignal(value) || typeof value === "function") {
		const dispose = effect(() => apply((value as () => unknown)()));
		cleanups.push(dispose);
	} else {
		apply(value);
	}
}

function applyEventSlot(
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
