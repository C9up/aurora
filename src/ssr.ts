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
	// Which quote closes the directive currently being skipped, so the closing
	// one consumed is the one that was opened. Undefined when none is pending.
	let pendingClosingQuote: '"' | "'" | undefined;
	const scanner = new TagScanner();
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
		if (directiveMatch) {
			const [whole = "", , quote] = directiveMatch;
			segment = segment.slice(0, segment.length - whole.length);
			// Only a quoted directive leaves a closing quote to swallow.
			pendingClosingQuote =
				quote === '"' ? '"' : quote === "'" ? "'" : undefined;
		}
		out += segment;
		scanner.consume(segment);
		if (i < values.length && !skipValue) {
			const value = values[i];
			const inAttr = scanner.insideTag;
			if (inAttr) {
				const rendered = stringifyValue(value, true);
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
				const rendered = stringifyValue(value, false);
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
 * Tracks whether the cursor sits inside a tag, scanning FORWARD as the output
 * grows.
 *
 * The obvious version walked backwards looking for the nearest `<` or `>`, but
 * a `>` inside a quoted attribute value — `title="a > b"` — reads as the end of
 * the tag, so the next interpolation is treated as a text slot and gets wrapped
 * in `<!--$-->` markers INSIDE an attribute. That corrupts the markup and
 * desyncs every following slot path at hydration. Quotes are what disambiguate,
 * and they can only be resolved by reading forward.
 *
 * State is carried across appends instead of re-derived, so the whole render
 * stays linear.
 */
class TagScanner {
	#inTag = false;
	/** The quote character currently open inside a tag, or empty. */
	#quote = "";

	/** Feed everything appended since the last call. */
	consume(chunk: string): void {
		for (let i = 0; i < chunk.length; i++) {
			const c = chunk[i];
			if (this.#quote !== "") {
				if (c === this.#quote) this.#quote = "";
				continue;
			}
			if (this.#inTag) {
				if (c === '"' || c === "'") this.#quote = c;
				else if (c === ">") this.#inTag = false;
				continue;
			}
			if (c === "<") this.#inTag = true;
		}
	}

	/** True when the cursor is inside a tag — an attribute region. */
	get insideTag(): boolean {
		return this.#inTag;
	}
}

function stringifyValue(value: unknown, inAttribute: boolean): string {
	if (value === null || value === undefined || value === false) return "";
	if (value === true) return inAttribute ? "" : "true";
	if (isSignal(value)) return stringifyValue(value(), inAttribute);
	if (typeof value === "function") {
		// A function here is a reactive expression — `class="${() => …}"` in an
		// attribute, `${() => …}` in text — and is evaluated eagerly
		// server-side. Directive values (`@click`, `?disabled`, `.prop`) never
		// reach this point: the scanner skips them, whatever quoting they use.
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
