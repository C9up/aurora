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
	assertBindableProperty,
	type BindablePosition,
	TemplateScanner,
} from "./templateScanner.js";
import { isTemplateResult, type TemplateResult } from "./types.js";
import {
	hasUnsafeScheme,
	isUrlAttribute,
	UNSAFE_URL_PREFIX,
} from "./urlGuard.js";

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

/**
 * A navigation attribute's value, held back until it is complete.
 *
 * `href` cannot be judged one slot at a time. `href="java${'script:alert(1)'}"`
 * is safe in each half and a running script once they meet, and an array value
 * concatenates into one in the same way — so the earlier per-slot guard passed
 * both through and the server shipped live markup that the client then
 * neutralised, too late, after hydration. The client never had this problem: it
 * writes the whole value at once. The server has to hold it to get the same
 * answer.
 */
interface HeldValue {
	/** The value's markup so far. */
	markup: string;
	/**
	 * Has a slot contributed to it?
	 *
	 * A value made only of the template's own text is authored code, and the
	 * client does not guard those either — it only ever sees slots. Agreeing with
	 * the client matters more here than guarding a string nobody interpolated.
	 */
	fromSlot: boolean;
}

function stringifyTemplateResult(result: TemplateResult): string {
	const { strings, values } = result;
	let out = "";
	let held: HeldValue | undefined;
	/**
	 * A `<textarea .value="${v}">`'s text, waiting for the tag to close.
	 *
	 * A textarea has no `value` ATTRIBUTE — its value is its content — so this is
	 * the only place the server can put it, and it is past the `>`. Held until
	 * then rather than dropped: `.value` is where the refusal for a slot inside
	 * `<textarea>` sends the author, so it had better reach the markup. Without
	 * it, a server-rendered form arrived with empty fields, and a submit before
	 * hydration sent nothing.
	 */
	let pendingContent: string | undefined;
	const scanner = new TemplateScanner();

	/** Emit the held value, guarded once, and go back to writing straight out. */
	const release = (): void => {
		if (held === undefined) return;
		const { markup, fromSlot } = held;
		held = undefined;
		out += needsNeutralising(markup, fromSlot)
			? UNSAFE_URL_PREFIX + markup
			: markup;
	};

	/**
	 * Append markup and move the scanner with it, splitting at the boundaries of
	 * a navigation attribute's value.
	 *
	 * Whole chunks everywhere except inside such a value, where it steps
	 * character by character. It has to: one reading after a chunk cannot say
	 * WHICH value ended if another one opened behind it, and `href="/a" id="b"`
	 * arrives as a single chunk.
	 */
	const write = (text: string): void => {
		if (text === "") return;
		if (pendingContent !== undefined && scanner.inTag) {
			// Step to the `>` so the content lands right after it. Character by
			// character rather than looking for the `>`, because one inside a
			// later quoted attribute value is not the end of the tag — and asking
			// the scanner is how that stays a single rule.
			for (let k = 0; k < text.length; k++) {
				const char = text.charAt(k);
				scanner.consume(char);
				out += char;
				if (!scanner.inTag) {
					out += pendingContent;
					pendingContent = undefined;
					write(text.slice(k + 1));
					return;
				}
			}
			return;
		}
		if (held !== undefined) {
			const end = scanner.valueEndIn(text);
			if (end === -1) {
				// The value runs past this chunk; all of it is value.
				scanner.consume(text);
				held.markup += text;
				return;
			}
			// The value and the character that ends it, in one step.
			scanner.consume(text.slice(0, end + 1));
			held.markup += text.slice(0, end);
			release();
			// The character that ended the value belongs after it, and the rest of
			// the chunk is ordinary markup again.
			out += text.charAt(end);
			write(text.slice(end + 1));
			return;
		}
		scanner.consume(text);
		const position = scanner.position;
		if (
			(position === "quoted-value" || position === "unquoted-value") &&
			isUrlAttribute(scanner.element, scanner.attribute)
		) {
			// The value opened inside this chunk, so its characters are the chunk's
			// tail and `valueLength` says how many.
			const kept = Math.max(text.length - scanner.valueLength, 0);
			out += text.slice(0, kept);
			held = { markup: text.slice(kept), fromSlot: false };
			return;
		}
		out += text;
	};

	// When a segment ends with a directive (` @click="`, ` ?disabled="`,
	// ` .value="`), we drop the directive prefix from that segment, skip
	// the matching value, and consume the closing `"` from the next
	// segment. This three-step coordination is why the loop holds a
	// `pendingClosingQuote` flag.
	// Which quote closes the directive currently being skipped, so the closing
	// one consumed is the one that was opened. Undefined when none is pending.
	let pendingClosingQuote: '"' | "'" | undefined;
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
		// Set when the skipped directive is `.value`. WHICH element it belongs to is
		// read after the segment is written, not here: until the scanner has
		// consumed `<textarea `, it does not know what tag this is.
		let valueDirective = false;
		// Set for any `.prop`, checked once the segment is written for the same
		// reason: whether `.textContent` is harmless depends on the element.
		let propertyName: string | undefined;
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
			if (directive.startsWith(".")) propertyName = directive.slice(1);
			// `.value` is the one property with a server-side spelling, and it
			// differs by element: an `<input>` carries it as an attribute, a
			// `<textarea>` as its content. Every other `.prop` stays client-only —
			// it has no markup to be written into.
			valueDirective = directive === ".value";
			// Only a quoted directive leaves a closing quote to swallow.
			pendingClosingQuote =
				quote === '"' ? '"' : quote === "'" ? "'" : undefined;
		}
		write(segment);
		if (propertyName !== undefined) {
			// Refused here too, though the server writes no `.prop` but `.value`: a
			// template must not render on one path and throw on the other.
			assertBindableProperty(scanner.element, propertyName);
		}
		if (booleanAttrName !== undefined && i < values.length) {
			// Present-and-empty when truthy, absent otherwise — byte-for-byte
			// what applyBooleanAttrSlot writes on the client, so hydration
			// re-applying the effect is a no-op instead of a correction.
			if (resolveBooleanValue(values[i])) write(` ${booleanAttrName}=""`);
		}
		if (valueDirective && i < values.length) {
			const valueElement = scanner.element;
			if (valueElement === "input") {
				write(` value="${stringifyValue(values[i], "quoted-value")}"`);
			} else if (valueElement === "textarea") {
				// Escaped for text, not for an attribute, and emitted once the tag
				// closes — see `pendingContent`.
				pendingContent = stringifyValue(values[i], "text");
			}
		}
		if (i < values.length && !skipValue) {
			const value = values[i];
			const position = assertBindable(scanner);
			if (position !== "text") {
				if (held !== undefined) held.fromSlot = true;
				// Escaped for its context; the URL decision waits for the whole
				// value, in `release`.
				write(stringifyValue(value, position));
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
				// The markers are aurora's own and must stay invisible to the
				// scanner, so they go straight out rather than through `write`.
				// A text slot is never inside a held value anyway.
				out += `<!--${SLOT_START}-->`;
				out += rendered;
				out += `<!--${SLOT_END}-->`;
				// A text-region value may itself carry markup (a nested template
				// or a SafeString), so it has to move the scanner too.
				scanner.consume(rendered);
			}
		}
	}
	// A template that ends inside an attribute value — `<a href="${x}` with no
	// closing quote — still has to emit what it held, guarded.
	release();
	return out;
}

/**
 * Undo exactly the escapes written above, and nothing else.
 *
 * NOT an HTML entity decoder, and it must not be mistaken for one. It exists so
 * the URL check reads a held value the way the browser will: `escapeUnquotedAttr`
 * writes a tab as `&#9;`, the browser decodes it and then strips it while
 * resolving the scheme, so `java<TAB>script:` checked against the MARKUP would
 * read as the harmless literal `java&#9;script:` and sail through.
 *
 * It covers what this module emits. An exotic named entity the template author
 * typed by hand is left alone, and that is the right boundary: the static text
 * of a template is authored code, not data — for it to matter, the author would
 * have to spell half the attack themselves.
 */
const OWN_ESCAPES: ReadonlyArray<readonly [string, string]> = [
	["&quot;", '"'],
	["&#39;", "'"],
	["&lt;", "<"],
	["&gt;", ">"],
	["&#32;", " "],
	["&#9;", "\t"],
	["&#10;", "\n"],
	["&#13;", "\r"],
	["&#12;", "\f"],
	["&#47;", "/"],
	["&#61;", "="],
	["&#96;", "`"],
	// Last, mirroring `escapeAttr`, which writes `&` first. Undoing it earlier
	// would let `&amp;#9;` — an author's literal `&#9;` — decode to a tab.
	["&amp;", "&"],
];

/**
 * Does this held value have to be made inert?
 *
 * The two cheap tests come first and carry almost every call. A scheme needs a
 * `:`, and the only way one can hide from a plain reading is inside a character
 * reference, which needs an `&` — so a value with neither cannot be unsafe, and
 * that is what `/items/42` looks like. Without this, every link on the page paid
 * for thirteen passes of {@link decodeOwnEscapes} plus a scheme comparison, and a
 * page of four hundred links rendered 57% slower for it.
 */
function needsNeutralising(markup: string, fromSlot: boolean): boolean {
	if (!fromSlot) return false;
	if (!markup.includes(":") && !markup.includes("&")) return false;
	return hasUnsafeScheme(decodeOwnEscapes(markup));
}

function decodeOwnEscapes(markup: string): string {
	let out = markup;
	for (const [encoded, decoded] of OWN_ESCAPES) {
		out = out.replaceAll(encoded, decoded);
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
	// Plain value — escaped for the context it is written into. The URL decision
	// is NOT made here: it needs the whole attribute value, and only the caller
	// has that, once it has held the value to its end.
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
	return (
		s
			.replaceAll("&", "&amp;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&#39;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			// A raw CR in an attribute value does not survive being parsed: the
			// tokenizer normalises it to a newline, so the DOM built from this
			// markup held a different string than the one the client's
			// `setAttribute` wrote, and hydration reported a mismatch on a value
			// that was never wrong. A character reference is decoded after that
			// normalisation, which is how a CR is kept.
			.replaceAll("\r", "&#13;")
	);
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
