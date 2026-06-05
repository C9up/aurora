/**
 * Tagged-template HTML parser.
 *
 *   html`<button @click="${onClick}">${count}</button>`
 *
 * returns a `TemplateResult`. The first call with a given `strings` array
 * compiles a `Template` (parsed `<template>` element + slot descriptors)
 * and caches it; subsequent calls reuse the compiled artefact and only
 * pair it with fresh `values`.
 *
 * The parser is intentionally minimal — it supports text interpolation
 * (`>${x}<`), attribute interpolation (`attr="${x}"` and multi-slot
 * `class="a ${x} b ${y}"`), boolean attributes (`?disabled="${x}"`), DOM
 * properties (`.value="${x}"`), and event listeners (`@click="${fn}"`).
 * No custom directives, no fragments-in-attribute-name, no comment-only
 * placeholders.
 */

import {
	type AttrSlot,
	type BooleanAttrSlot,
	type EventSlot,
	isTemplateResult,
	type PropSlot,
	type Slot,
	TEMPLATE_RESULT_BRAND,
	type Template,
	type TemplateResult,
	type TextSlot,
} from "./types.js";

const TEMPLATE_CACHE = new WeakMap<TemplateStringsArray, Template>();

/** Sentinel inserted at every `${...}` site. Read back during the walk. */
const MARKER = "__aurora_slot_";

/** Marker comment that takes a child slot inside a text region. */
const TEXT_NODE_MARKER = `<!--${MARKER}-->`;

/** Markup-friendly placeholder for slots inside attribute values. */
function attrPlaceholder(i: number): string {
	return `${MARKER}${i}__`;
}

/**
 * Build the HTML string + remember which slots landed where. The classifier
 * runs on the concatenated string; once we know each slot is either a
 * text-region slot or an attribute-region slot, we emit the correct
 * placeholder so the DOM parser doesn't choke (e.g. a `<!---->` comment
 * cannot live inside an attribute value).
 */
interface RawSlot {
	region: "text" | "attribute";
}

function classifySlots(strings: readonly string[]): RawSlot[] {
	const result: RawSlot[] = [];
	let insideTag = false;
	let insideComment = false;
	for (let i = 0; i < strings.length - 1; i++) {
		const segment = strings[i];
		for (let j = 0; j < segment.length; j++) {
			if (insideComment) {
				// Comments swallow everything (including stray `<` / `>`) up
				// to the literal `-->` terminator; without this guard a
				// `<!-- > -->` literal would flip the tag scanner mid-stride.
				if (
					segment[j] === "-" &&
					segment[j + 1] === "-" &&
					segment[j + 2] === ">"
				) {
					insideComment = false;
					j += 2;
				}
				continue;
			}
			if (
				!insideTag &&
				segment[j] === "<" &&
				segment[j + 1] === "!" &&
				segment[j + 2] === "-" &&
				segment[j + 3] === "-"
			) {
				insideComment = true;
				j += 3;
				continue;
			}
			const ch = segment[j];
			if (!insideTag && ch === "<") insideTag = true;
			else if (insideTag && ch === ">") insideTag = false;
		}
		result.push({ region: insideTag ? "attribute" : "text" });
	}
	return result;
}

/**
 * Build the HTML markup to feed the `<template>` element.
 *
 * Slots in text regions are replaced with a `<!--__aurora_slot_-->` comment
 * that survives DOM parsing. Slots in attribute regions are replaced with a
 * unique string token like `__aurora_slot_3__` that the post-parse walk
 * detects when scanning attribute values.
 */
function buildMarkup(
	strings: readonly string[],
	classification: readonly RawSlot[],
): string {
	let out = strings[0];
	for (let i = 0; i < classification.length; i++) {
		out +=
			classification[i].region === "text"
				? TEXT_NODE_MARKER
				: attrPlaceholder(i);
		out += strings[i + 1];
	}
	return out;
}

/**
 * Walk the parsed fragment and collect a slot descriptor for every
 * placeholder we emitted. The walk is depth-first, child-by-child, and
 * records the integer path so `render()` can re-walk a clone without any
 * string parsing.
 */
function collectSlots(
	root: HTMLTemplateElement,
	classification: readonly RawSlot[],
): Slot[] {
	const slots: Slot[] = [];
	let slotIndex = 0;

	// Classify one marker-bearing attribute into slot(s): `@event`, `?boolean`,
	// `.prop`, or a (possibly multi-slot) regular attribute. Pushes the slot(s)
	// and queues the attribute for removal from the inert template.
	function classifyAttribute(
		attr: Attr,
		path: number[],
		toRemove: string[],
	): void {
		const value = attr.value;
		if (!value.includes(MARKER)) return;
		const localPath = [...path];
		if (attr.name.startsWith("@")) {
			const slot: EventSlot = {
				kind: "event",
				path: localPath,
				event: attr.name.slice(1),
			};
			slots.push(slot);
			slotIndex++;
			toRemove.push(attr.name);
			return;
		}
		if (attr.name.startsWith("?")) {
			const slot: BooleanAttrSlot = {
				kind: "boolean-attr",
				path: localPath,
				name: attr.name.slice(1),
			};
			slots.push(slot);
			slotIndex++;
			toRemove.push(attr.name);
			return;
		}
		if (attr.name.startsWith(".")) {
			const slot: PropSlot = {
				kind: "prop",
				path: localPath,
				name: attr.name.slice(1),
			};
			slots.push(slot);
			slotIndex++;
			toRemove.push(attr.name);
			return;
		}
		// Regular attribute — may host one or more slots inline with static text.
		// Strip the placeholder version (the renderer re-applies via setAttribute)
		// so the inert template never carries the `__aurora_slot_0__` artefact.
		const parts = value.split(/__aurora_slot_(\d+)__/);
		// Even indices = static text, odd = slot indices. One slot with no
		// surrounding static text → a "pure" attr slot; else carry static parts.
		if (parts.length === 3 && parts[0] === "" && parts[2] === "") {
			const slot: AttrSlot = { kind: "attr", path: localPath, name: attr.name };
			slots.push(slot);
			slotIndex++;
		} else {
			// Multi-slot attribute. Each slot points at the same `staticParts`
			// array; consumers re-join on every update.
			const staticParts: string[] = [];
			const slotCountInThisAttr = (parts.length - 1) / 2;
			for (let i = 0; i < parts.length; i += 2) {
				staticParts.push(parts[i]);
			}
			for (let i = 0; i < slotCountInThisAttr; i++) {
				const slot: AttrSlot = {
					kind: "attr",
					path: localPath,
					name: attr.name,
					staticParts,
					staticPartIndex: i,
				};
				slots.push(slot);
				slotIndex++;
			}
		}
		toRemove.push(attr.name);
	}

	function visit(node: Node, path: number[]): void {
		// Process children FIRST in reverse so a comment-marker we're about
		// to remove never invalidates the index of a later sibling. But text
		// slots also bring the node into existence — handle them with a
		// stable path captured up front.
		if (node.nodeType === 8 /* Comment */) {
			const data = (node as Comment).data;
			if (data === MARKER) {
				if (slotIndex >= classification.length) return;
				const cls = classification[slotIndex];
				if (cls.region !== "text") {
					throw new Error(
						`[aurora] internal classification mismatch at slot ${slotIndex}`,
					);
				}
				const slot: TextSlot = { kind: "text", path: [...path] };
				slots.push(slot);
				slotIndex++;
			}
			return;
		}
		if (node.nodeType === 1 /* Element */) {
			const el = node as Element;
			// Scan attributes — multiple slots can share one attribute.
			// Collect attrs to remove AFTER iteration (mutating during it
			// shifts indices on some DOM implementations).
			const toRemove: string[] = [];
			for (const attr of Array.from(el.attributes)) {
				classifyAttribute(attr, path, toRemove);
			}
			for (const name of toRemove) el.removeAttribute(name);
		}
		// Recurse into children with their indices.
		let childIndex = 0;
		let child = node.firstChild;
		while (child) {
			const nextSibling: ChildNode | null = child.nextSibling;
			visit(child, [...path, childIndex]);
			child = nextSibling;
			childIndex++;
		}
	}

	visit(root.content, []);
	return slots;
}

function compile(strings: TemplateStringsArray): Template {
	const classification = classifySlots(strings);
	const markup = buildMarkup(strings, classification);
	const tpl = document.createElement("template");
	tpl.innerHTML = markup;
	const slots = collectSlots(tpl, classification);
	return { element: tpl, slots };
}

/**
 * Compile (and cache) the template for the given strings array. Exposed
 * for the renderer + the SSR path; apps stick to `html`.
 */
export function getTemplate(strings: TemplateStringsArray): Template {
	let cached = TEMPLATE_CACHE.get(strings);
	if (!cached) {
		cached = compile(strings);
		TEMPLATE_CACHE.set(strings, cached);
	}
	return cached;
}

/**
 * Tagged-template entrypoint. The `strings` array is reference-stable per
 * source location (TC39 guarantee), so caching by reference is safe and
 * O(1) on the hot render path.
 */
export function html(
	strings: TemplateStringsArray,
	...values: unknown[]
): TemplateResult {
	const result: TemplateResult = {
		strings,
		values,
		[TEMPLATE_RESULT_BRAND]: true,
	};
	return result;
}

export { isTemplateResult };
