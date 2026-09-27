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
import {
	assertBindable,
	type BindablePosition,
	TemplateScanner,
} from "./templateScanner.js";
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
	// Which quote closes the directive currently being skipped, so the closing
	// one consumed is the one that was opened. Undefined when none is pending.
	let pendingClosingQuote: '"' | "'" | undefined;
	const scanner = new TemplateScanner();
	for (const [i, raw] of strings.entries()) {
		let segment = raw;
		if (pendingClosingQuote !== undefined) {
			segment =
				pendingClosingQuote === '"'
					? segment.replace(/^"/, "")
					: segment.replace(/^'/, "");
			pendingClosingQuote = undefined;
		}
		// Both quote styles. Matching only `="` left `@click='${handler}'`
		// unrecognised, so the handler fell through to `stringifyValue`, which
		// CALLED it — a client event handler running on the server, its return
		// value written into the HTML, and any exception swallowed.
		const directiveMatch = segment.match(/\s([@?.][\w-]+)=("|'|)$/);
		const skipValue = directiveMatch !== null;
		// Set when the skipped directive is a boolean attribute, which — unlike
		// the other two — still has markup to emit. See below.
		let booleanAttrName: string | undefined;
		if (directiveMatch) {
			const [whole = "", directive = "", quote] = directiveMatch;
			segment = segment.slice(0, segment.length - whole.length);
			// `?disabled=${x}` is HTML STATE, not a client-only binding.
			// `@click` is a listener and `.value` a DOM property: neither
			// exists until the runtime binds it, so dropping them is right.
			// A boolean attribute is different — the browser acts on it while
			// parsing. Skipping it too made the server contradict the very
			// first client render: a `?hidden` panel arrived visible and
			// blinked away once hydration caught up.
			if (directive.startsWith("?")) booleanAttrName = directive.slice(1);
			// Only a quoted directive leaves a closing quote to swallow.
			pendingClosingQuote =
				quote === '"' ? '"' : quote === "'" ? "'" : undefined;
		}
		out += segment;
		scanner.consume(segment);
		if (booleanAttrName !== undefined && i < values.length) {
			// Present-and-empty when truthy, absent otherwise — byte-for-byte
			// what applyBooleanAttrSlot writes on the client, so hydration
			// re-applying the effect is a no-op instead of a correction.
			if (resolveBooleanValue(values[i])) {
				const rendered = ` ${booleanAttrName}=""`;
				out += rendered;
				scanner.consume(rendered);
			}
		}
		if (i < values.length && !skipValue) {
			const value = values[i];
			const position = scanner.position;
			assertBindable(position);
			if (position !== "text") {
				const rendered = stringifyValue(value, position);
				out += rendered;
				scanner.consume(rendered);
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
				const rendered = stringifyValue(value, "text");
				out += `<!--${SLOT_START}-->`;
				out += rendered;
				out += `<!--${SLOT_END}-->`;
				// A text-region value may itself carry markup (a nested template
				// or a SafeString), so it has to move the scanner too.
				scanner.consume(rendered);
			}
		}
	}
	return out;
}

/** Boundary-marker comment payloads (kept in sync with hydrate.ts). */
const SLOT_START = "$";
const SLOT_END = "/$";

/**
 * Read a boolean attribute's value the way the client reads it: a signal or a
 * reactive expression is called ONCE, then coerced. One level is not an
 * approximation — `applyBooleanAttrSlot` does exactly the same, so a signal
 * that returns a signal is truthy on both sides.
 */
function resolveBooleanValue(value: unknown): boolean {
	if (isSignal(value) || typeof value === "function") {
		try {
			return Boolean((value as () => unknown)());
		} catch {
			// Same fail-soft as stringifyValue: an expression that throws
			// server-side leaves the attribute off and lets the client effect
			// decide once it has a real DOM to read.
			return false;
		}
	}
	return Boolean(value);
}

function stringifyValue(value: unknown, context: BindablePosition): string {
	const inAttribute = context !== "text";
	if (value === null || value === undefined || value === false) return "";
	if (value === true) return inAttribute ? "" : "true";
	if (isSignal(value)) return stringifyValue(value(), context);
	if (typeof value === "function") {
		// A function here is a reactive expression — `class="${() => …}"` in an
		// attribute, `${() => …}` in text — and is evaluated eagerly
		// server-side. Directive values (`@click`, `?disabled`, `.prop`) never
		// reach this point: the scanner skips them, whatever quoting they use.
		try {
			return stringifyValue((value as () => unknown)(), context);
		} catch {
			return "";
		}
	}
	if (Array.isArray(value)) {
		let out = "";
		for (const item of value) out += stringifyValue(item, context);
		return out;
	}
	if (isTemplateResult(value)) return stringifyTemplateResult(value);
	// Plain value — escaped for the context it is being written into.
	const text = String(value);
	if (context === "text") return escapeText(text);
	return context === "quoted-value"
		? escapeAttr(text)
		: escapeUnquotedAttr(text);
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

/**
 * Escape a value being written into an UNQUOTED attribute — `<img src=${url}>`.
 *
 * `escapeAttr` is not enough here, and the gap was a hole. It escapes the two
 * quote characters, which is exactly what protects a quoted value and does
 * nothing at all for a value with no quotes around it: the HTML tokenizer ends
 * an unquoted value at the first whitespace character, so `x onerror=alert(1)`
 * came out of the server as `src=x onerror=alert(1)` — one attribute in, two
 * attributes out, the second one a handler. The client renderer was never
 * affected; it normalises the value into a single quoted attribute, so this was
 * the server contradicting it as well as injecting.
 *
 * The fix is to encode the characters that can END the value rather than the
 * ones that can end a quoted one. Character references ARE decoded in the
 * unquoted attribute value state, so `&#32;` reaches the DOM as a space and the
 * attribute keeps the value it was given — byte-different from the client's
 * markup, identical once parsed, which is what hydration compares.
 *
 * `>` and `/` are in the set for the same reason as the whitespace: `>` ends the
 * tag, and a trailing `/` merges with the `>` of a self-closing void element and
 * silently joins the value. `=` and a backtick are parse errors rather than
 * terminators, encoded because the value is hostile by assumption and it costs
 * nothing.
 */
const UNQUOTED_ESCAPES: ReadonlyMap<string, string> = new Map([
	[" ", "&#32;"],
	["\t", "&#9;"],
	["\n", "&#10;"],
	["\r", "&#13;"],
	["\f", "&#12;"],
	["/", "&#47;"],
	["=", "&#61;"],
	["`", "&#96;"],
]);

function escapeUnquotedAttr(s: string): string {
	let out = "";
	// escapeAttr first, so `&` is encoded once and before these expansions add
	// their own — otherwise `&#32;` would come back out as `&amp;#32;`.
	for (const char of escapeAttr(s)) out += UNQUOTED_ESCAPES.get(char) ?? char;
	return out;
}

// VOID_ELEMENTS exported for downstream tooling (hydration heuristics).
export { VOID_ELEMENTS };
