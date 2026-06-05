/**
 * Shared types for aurora templates.
 *
 * A `TemplateResult` is what `html\`...\`` returns. It carries the raw
 * pieces (strings, values) and a stable reference to the parsed
 * `Template` (memoised by `strings`). Templates are framework-internal —
 * apps only ever see `TemplateResult`.
 */

/**
 * A lifecycle/effect callback that runs and OPTIONALLY returns a cleanup
 * function — exactly React's `EffectCallback = () => void | (() => void)`.
 *
 * The `void` member of the return union is load-bearing: it is what makes a
 * plain `() => {}` (whose return type is `void`) assignable here. Replacing it
 * with `(() => void) | undefined` makes every void-returning callback a type
 * error (a `() => void` is NOT assignable to `() => (() => void) | undefined`).
 * So `noConfusingVoidType` is suppressed once, at this single definition,
 * instead of being worked around at ~15 call sites with broken types.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` is required so plain void-returning callbacks stay assignable (React EffectCallback pattern; dropping it breaks ~10 call sites)
export type EffectCallback = () => void | (() => void);

/** Slot descriptor — where a `${value}` lives inside a parsed template. */
export type SlotKind = "text" | "attr" | "event" | "boolean-attr" | "prop";

/**
 * Path to the binding point inside the cloned template. Each step is a
 * child index. We never walk by query selectors because attribute and text
 * placements would need synthetic markers in markup an app provided.
 */
export type NodePath = readonly number[];

export interface TextSlot {
	kind: "text";
	path: NodePath;
}
export interface AttrSlot {
	kind: "attr";
	path: NodePath;
	name: string;
	/**
	 * When the attribute interpolates more than one `${...}` slot, every
	 * slot shares the same `name` and the static segments are stored under
	 * `staticParts`. The render step joins them back together each tick.
	 */
	staticParts?: readonly string[];
	staticPartIndex?: number;
}
export interface EventSlot {
	kind: "event";
	path: NodePath;
	event: string;
}
export interface BooleanAttrSlot {
	kind: "boolean-attr";
	path: NodePath;
	name: string;
}
export interface PropSlot {
	kind: "prop";
	path: NodePath;
	name: string;
}

export type Slot = TextSlot | AttrSlot | EventSlot | BooleanAttrSlot | PropSlot;

/** Compiled artefact — produced once per unique `strings` array. */
export interface Template {
	/**
	 * A `<template>` element whose `content` fragment is cloned on every
	 * render. Cloning is much cheaper than re-parsing the HTML string.
	 */
	readonly element: HTMLTemplateElement;
	/** Slot descriptors in source order (same order as the `${...}` values). */
	readonly slots: readonly Slot[];
}

/** Tagged-template return value — what `html\`\`` produces. */
export interface TemplateResult {
	readonly strings: TemplateStringsArray;
	readonly values: readonly unknown[];
	readonly [TEMPLATE_RESULT_BRAND]: true;
}

export const TEMPLATE_RESULT_BRAND: unique symbol = Symbol.for(
	"aurora:template-result",
);

export function isTemplateResult(value: unknown): value is TemplateResult {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [TEMPLATE_RESULT_BRAND]?: boolean })[TEMPLATE_RESULT_BRAND] ===
			true
	);
}
