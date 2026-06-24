/**
 * Render a `TemplateResult` to the DOM and keep it reactive.
 *
 * `render(template, container)` clones the parsed `<template>`, walks to
 * each slot, attaches the corresponding value (with `effect()` for any
 * reactive expression), and appends the result to the container. The
 * returned dispose function tears down every effect and removes the
 * mounted nodes.
 */

import { readComponentLifecycle } from "./component.js";
import { getTemplate } from "./html.js";
import { effect, isSignal } from "./reactive.js";
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

export type Disposer = () => void;

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
	const mountedNodes: ChildNode[] = [];
	const mountHooks: Array<EffectCallback> = [];

	const fragment = mount(result, cleanups, mountedNodes, mountHooks);
	container.appendChild(fragment);

	// `onMount` hooks fire after the fragment is live in the document so
	// callbacks that measure / focus / observe see a real DOM. A returned
	// cleanup function joins the unmount queue.
	for (const hook of mountHooks) {
		try {
			const teardown = hook();
			if (typeof teardown === "function") cleanups.push(teardown);
		} catch {
			/* swallow — one bad onMount should not block sibling components */
		}
	}

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		for (const c of cleanups.splice(0)) c();
		for (const node of mountedNodes) node.remove();
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
 * Build a fragment for a TemplateResult and register cleanups.
 *
 * @internal Exported so `hydrate.ts` can client-render a reactive
 * nested-template subtree when the signal changes after hydration
 * (the swap path — see `hydrateTextSlot`).
 */
export function mount(
	result: TemplateResult,
	cleanups: Disposer[],
	mounted: ChildNode[],
	mountHooks: Array<EffectCallback>,
): DocumentFragment {
	const tpl = getTemplate(result.strings);
	const fragment = tpl.element.content.cloneNode(true) as DocumentFragment;

	// Forward any component()-attached lifecycle from this result.
	const lifecycle = readComponentLifecycle(result);
	if (lifecycle) {
		for (const hook of lifecycle.mountHooks) mountHooks.push(hook);
		for (const c of lifecycle.cleanups) cleanups.push(c);
	}

	// Multi-slot attrs need every contributing value before we can join
	// the final string. Collect them in a first pass, attach effects
	// after.
	const multiGroups = new Map<string, MultiAttrGroup>();

	for (let i = 0; i < tpl.slots.length; i++) {
		const slot = tpl.slots[i];
		const node = resolvePath(fragment, slot.path);
		if (node === null) {
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
		if (slot.kind === "attr" && slot.staticParts !== undefined) {
			collectMultiAttr(slot, node as Element, result.values[i], multiGroups);
		} else {
			applySlot(slot, node, result.values[i], cleanups, mounted, mountHooks);
		}
	}

	for (const group of multiGroups.values()) {
		applyMultiAttrGroup(group, cleanups);
	}

	for (const child of Array.from(fragment.childNodes)) {
		mounted.push(child);
	}
	return fragment;
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
	mounted: ChildNode[],
	mountHooks: Array<EffectCallback>,
): void {
	switch (slot.kind) {
		case "text":
			applyTextSlot(
				slot,
				node as Comment,
				value,
				cleanups,
				mounted,
				mountHooks,
			);
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
 */
function applyTextSlot(
	_slot: TextSlot,
	anchor: Comment,
	value: unknown,
	cleanups: Disposer[],
	mounted: ChildNode[],
	mountHooks: Array<EffectCallback>,
): void {
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

	function set(newValue: unknown): void {
		disposeLocal();
		for (const n of currentNodes) n.remove();
		currentNodes = [];
		const nodes = renderValueIntoNodes(
			newValue,
			localCleanups,
			mounted,
			mountHooks,
		);
		const parent = anchor.parentNode;
		if (!parent) return;
		for (const n of nodes) {
			parent.insertBefore(n, anchor);
			currentNodes.push(n);
		}
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
		});
	} else {
		set(value);
		// Static value never re-runs, but its subtree (e.g. a one-shot
		// nested template) still needs to be disposed with the root.
		cleanups.push(disposeLocal);
	}
}

function renderValueIntoNodes(
	value: unknown,
	cleanups: Disposer[],
	mounted: ChildNode[],
	mountHooks: Array<EffectCallback>,
): ChildNode[] {
	if (value === null || value === undefined || value === false) return [];
	if (Array.isArray(value)) {
		const out: ChildNode[] = [];
		for (const item of value) {
			out.push(...renderValueIntoNodes(item, cleanups, mounted, mountHooks));
		}
		return out;
	}
	if (isTemplateResult(value)) {
		const frag = mount(value, cleanups, mounted, mountHooks);
		return Array.from(frag.childNodes);
	}
	if (value instanceof Node) {
		return [value as ChildNode];
	}
	return [document.createTextNode(String(value))];
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
			el.setAttribute(slot.name, String(v));
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
	if (hasReactive) {
		const dispose = effect(() => {
			group.el.setAttribute(group.name, join());
		});
		cleanups.push(dispose);
	} else {
		group.el.setAttribute(group.name, join());
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
		(el as unknown as Record<string, unknown>)[slot.name] = v;
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
