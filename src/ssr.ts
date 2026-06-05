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
			if (!inAttr && isReactiveStructuredSlot(value)) {
				// Reactive text slot whose value is a nested template /
				// array — wrap the rendered content in boundary markers so
				// hydration can locate the exact node range and SWAP it when
				// the signal changes client-side. Without these markers a
				// nested-template slot hydrates once and then goes stale
				// (no way to find where the subtree starts/ends). Scalar
				// reactive slots (`${signal}` → text) are NOT wrapped: their
				// hydration updates the text node in place, no range needed.
				out += `<!--${SLOT_START}-->`;
				out += stringifyValue(value, false);
				out += `<!--${SLOT_END}-->`;
			} else {
				out += stringifyValue(value, inAttr);
			}
		}
	}
	return out;
}

/** Boundary-marker comment payloads (kept in sync with hydrate.ts). */
const SLOT_START = "$";
const SLOT_END = "/$";

/**
 * True when `value` is a reactive expression (signal / function) whose
 * current evaluation is a structured node payload (a nested
 * TemplateResult, or an array). These are the slots that can SWAP their
 * subtree on a client-side change and therefore need boundary markers
 * for hydration to find the range. A reactive slot resolving to a
 * scalar (string / number) is updated in place and needs no markers.
 */
function isReactiveStructuredSlot(value: unknown): boolean {
	if (!isSignal(value) && typeof value !== "function") return false;
	let evaluated: unknown;
	try {
		evaluated = isSignal(value)
			? (value as () => unknown)()
			: (value as () => unknown)();
	} catch {
		return false;
	}
	return isTemplateResult(evaluated) || Array.isArray(evaluated);
}

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
