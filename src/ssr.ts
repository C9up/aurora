/**
 * Server-side rendering — produces an HTML string from a `TemplateResult`
 * without ever touching the DOM.
 *
 * Reads each slot's value eagerly (signals get a one-shot snapshot,
 * functions are invoked, nested TemplateResults recurse). Event handlers
 * are dropped server-side; hydration re-binds them once the markup
 * lands in the browser.
 */

import { isSignal } from "./reactive.js";
import { isTemplateResult, type TemplateResult } from "./types.js";

const VOID_ELEMENTS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"keygen",
	"link",
	"meta",
	"source",
	"track",
	"wbr",
]);

/**
 * Stringify a TemplateResult into HTML. Returns the markup ready to be
 * shipped over the wire — no surrounding `<html>`/`<head>`/`<body>`
 * unless the template includes them.
 *
 * The function walks the `strings` array directly; it does NOT depend
 * on the DOM-side template cache, so it works in any JS runtime (Node,
 * Cloudflare Workers, Bun, Deno).
 */
export function renderToString(result: TemplateResult): string {
	return stringifyTemplateResult(result);
}

function stringifyTemplateResult(result: TemplateResult): string {
	const { strings, values } = result;
	let out = "";
	// When a segment ends with a directive (` @click="`, ` ?disabled="`,
	// ` .value="`), we drop the directive prefix from that segment, skip
	// the matching value, and consume the closing `"` from the next
	// segment. This three-step coordination is why the loop holds a
	// `pendingClosingQuote` flag.
	let pendingClosingQuote = false;
	for (let i = 0; i < strings.length; i++) {
		let segment = strings[i];
		if (pendingClosingQuote) {
			segment = segment.replace(/^"/, "");
			pendingClosingQuote = false;
		}
		const directiveMatch = segment.match(/\s([@?.][\w-]+)="$/);
		const skipValue = directiveMatch !== null;
		if (directiveMatch) {
			segment = segment.slice(0, segment.length - directiveMatch[0].length);
			pendingClosingQuote = true;
		}
		out += segment;
		if (i < values.length && !skipValue) {
			const value = values[i];
			const inAttr = isInsideAttribute(out);
			if (inAttr) {
				out += stringifyValue(value, true);
			} else {
				// Text-region slot — ALWAYS wrap in boundary markers so the SSR
				// node structure matches the client template, which keeps exactly
				// ONE comment node per slot. An inlined value otherwise MERGES
				// with adjacent static text or sibling values when the browser
				// parses the SSR HTML (`<p>Hello ${x}!</p>` → ONE text node, not
				// three), dropping the node count and desyncing the slot AND every
				// following sibling binding (text, attr, event). Hydration
				// collapses each `<!--$-->…<!--/$-->` range back to one node
				// (collapseMarkerRanges) so paths align exactly; the range also
				// anchors scalar text updates and nested-template swaps. Same
				// part-marker approach as lit-html / Solid.
				out += `<!--${SLOT_START}-->`;
				out += stringifyValue(value, false);
				out += `<!--${SLOT_END}-->`;
			}
		}
	}
	return out;
}

/** Boundary-marker comment payloads (kept in sync with hydrate.ts). */
const SLOT_START = "$";
const SLOT_END = "/$";

/**
 * Returns true if the position at the end of `htmlSoFar` lives inside
 * the value region of an HTML tag (between `<` and `>`). The check
 * walks backwards from the end, which is the smallest hint we need to
 * decide between text-region and attribute-region escaping.
 */
function isInsideAttribute(htmlSoFar: string): boolean {
	for (let i = htmlSoFar.length - 1; i >= 0; i--) {
		const c = htmlSoFar.charCodeAt(i);
		if (c === 60 /* '<' */) return true;
		if (c === 62 /* '>' */) return false;
	}
	return false;
}

function stringifyValue(value: unknown, inAttribute: boolean): string {
	if (value === null || value === undefined || value === false) return "";
	if (value === true) return inAttribute ? "" : "true";
	if (isSignal(value)) return stringifyValue(value(), inAttribute);
	if (typeof value === "function") {
		// In attribute position: directive handlers (`@click`, `?disabled`,
		// `.prop`) have already been stripped by `stripDirectiveBefore`.
		// A function reaching this point is a reactive-expression text
		// slot (`${() => ...}`), which we evaluate eagerly server-side.
		try {
			return stringifyValue((value as () => unknown)(), inAttribute);
		} catch {
			return "";
		}
	}
	if (Array.isArray(value)) {
		let out = "";
		for (const item of value) out += stringifyValue(item, inAttribute);
		return out;
	}
	if (isTemplateResult(value)) return stringifyTemplateResult(value);
	// Plain value — escape HTML entities (text) or attribute special
	// characters (attribute value).
	return inAttribute ? escapeAttr(String(value)) : escapeText(String(value));
}

function escapeText(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function escapeAttr(s: string): string {
	// Escape BOTH quote styles: the engine doesn't force double-quoted
	// attributes (the classifier only tracks `<`/`>`), so a template author
	// writing `id='${x}'` must still be safe — without escaping `'` a value
	// like `' onmouseover='alert(1)` would break out of a single-quoted
	// attribute. `>` isn't strictly required inside a quoted value but is
	// escaped to stay safe under stray scanners that hunt tag boundaries
	// before resolving the quote context.
	return s
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

// VOID_ELEMENTS exported for downstream tooling (hydration heuristics).
export { VOID_ELEMENTS };
