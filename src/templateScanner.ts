/**
 * The one scanner that says where a `${}` landed in a template's markup.
 *
 * Both render paths need this answer, and each used to work it out for itself:
 * `html.ts` had `classifySlots`, `ssr.ts` had `TagScanner`. They were written
 * at different times against different needs and they disagreed on four
 * constructs — every disagreement a bug, two of them holes:
 *
 *   - `<${tag}>` — SSR spliced the value in RAW (markup injection); the client
 *     threw an internal-invariant error. Fixed once already, in both copies.
 *   - `<img ${name}="v">` — SSR spliced the NAME in raw (`onerror` and the
 *     value that goes with it); the client silently emitted its own internal
 *     token as the attribute name.
 *   - `<img src=${v}>` (unquoted) — SSR escaped only quotes, so a space in the
 *     value ended the attribute and everything after it became more
 *     attributes; the client was correct.
 *   - `<div title="a > b" class=${v}>` — only SSR tracked quotes, so the client
 *     read the `>` as the end of the tag and DROPPED every following attribute
 *     binding on that element, silently.
 *
 * A duplicate that has produced four divergences is not going to stop, so the
 * duplicate is what gets removed. One state machine, fed by both paths,
 * answering one question: what kind of position is the cursor in.
 *
 * It is a forward scan carrying state across chunks, not a backwards search
 * from the slot: a `>` inside a quoted value and a `<` inside a comment both
 * look like tag boundaries to anything that reads backwards, and only reading
 * forward resolves them. Linear in the markup either way.
 */

import {
	E_AURORA_FILE_INPUT_VALUE,
	E_AURORA_SLOT_IN_ATTRIBUTE_NAME,
	E_AURORA_SLOT_IN_BASE_URL,
	E_AURORA_SLOT_IN_COMMENT,
	E_AURORA_SLOT_IN_EVENT_ATTRIBUTE,
	E_AURORA_SLOT_IN_HTML_PROPERTY,
	E_AURORA_SLOT_IN_RAW_TEXT,
	E_AURORA_SLOT_IN_SCRIPT_SOURCE,
	E_AURORA_SLOT_IN_SRCDOC,
	E_AURORA_SLOT_IN_TAG_NAME,
	E_AURORA_TEMPLATE_IN_ATTRIBUTE,
} from "./errors.js";
import { isTemplateResult } from "./types.js";
import { SOURCE_ELEMENTS } from "./urlGuard.js";

/**
 * A literal `${}` for the refusal messages below, written as an escaped
 * template literal rather than a plain string so it reads as the interpolation
 * it names. A plain `"${}"` is what an author writes by accident when they meant
 * a template literal, which is the mistake `noTemplateCurlyInString` exists to
 * catch — and it is right to flag it, so the string says it differently rather
 * than silencing the rule.
 */
const INTERPOLATION = `\${}`;

/**
 * Where the cursor sits. Named by what the position IS, because what each
 * caller must do about it differs: a value gets escaped for its context, and
 * the two name positions get refused.
 */
export type SlotPosition =
	| "text"
	| "tag-name"
	| "attribute-name"
	| "quoted-value"
	| "unquoted-value"
	/**
	 * Inside an element whose content the parser does NOT read as markup —
	 * `<script>`, `<style>`, `<textarea>`, `<title>` and the rest.
	 *
	 * Not the same as text, and telling them apart is why this state exists. A
	 * `<` in there does not open a tag, so a scanner without this state reads
	 * `<textarea>2 < 3: ${v}</textarea>` as being inside a tag and calls the slot
	 * an attribute name. It also recovers by accident — the `>` of the closing
	 * tag ends the phantom tag — which is exactly the kind of accidental
	 * correctness that hid the earlier bugs.
	 */
	| "raw-text"
	/**
	 * Inside a comment, a bogus comment (`<!x …>`, `<?…>`, `</ …>`, a doctype)
	 * or a CDATA section. A slot there binds nothing, and the comment aurora
	 * anchors a text slot with ends the one it sits in — see
	 * {@link assertBindable}.
	 */
	| "comment";

/**
 * The positions a value can actually be written into — what is left once the
 * two name positions are refused. Naming it lets {@link assertBindable} narrow,
 * so each caller picks its escaping from a type that cannot include a position
 * it has already rejected.
 */
export type BindablePosition = Exclude<
	SlotPosition,
	"tag-name" | "attribute-name" | "raw-text" | "comment"
>;

/**
 * The tokenizer states between a `<` and the tag or comment it opens, and the
 * comment-like states that follow — named after the WHATWG states they stand
 * for. Empty in plain text, inside a tag and in raw text, which keep their own
 * fields.
 *
 * Each is stepped one character at a time, so a construct split across two
 * template strings reads the same as a whole one.
 */
type MarkupState =
	| ""
	/** After `<`: a letter opens a tag, `/` an end tag, `!` a declaration. */
	| "tag-open"
	/** After `</`: a letter opens an end tag, `>` is nothing, else bogus. */
	| "end-tag-open"
	/** After `<!`, reading what it declares: `--`, `[CDATA[` or anything else. */
	| "declaration"
	/** `<!x`, `<?`, `</ `, a doctype: everything up to the first `>`. */
	| "bogus-comment"
	| "comment-start"
	| "comment-start-dash"
	| "comment"
	| "comment-end-dash"
	| "comment-end"
	| "comment-end-bang"
	/** `<![CDATA[` in foreign content, up to `]]>`. */
	| "cdata"
	| "cdata-bracket"
	| "cdata-end";

function isAsciiLetter(char: string): boolean {
	return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
}

const CDATA_OPEN = "[CDATA[";

/** The characters that end an unquoted attribute value, plus `>` and `/`. */
function isSpace(char: string): boolean {
	return (
		char === " " ||
		char === "\t" ||
		char === "\n" ||
		char === "\r" ||
		char === "\f"
	);
}

/**
 * Which part of a tag the cursor is reading: the WHATWG tokenizer's states
 * between `<x` and `>`, one for one.
 *
 * Fewer states than the tokenizer was the source of every disagreement inside
 * a tag. With one "attribute name" state standing for three, whitespace before
 * an `=` started a new, nameless attribute, so `href ="${v}"` was a value of
 * nothing and every guard keyed on the name stood down. With the tag name read
 * up to the first whitespace, `<script/x>` was an element called `scriptx`. The
 * tokenizer has a state for each of these, and so does this.
 *
 * A quoted value is `"value"` with a quote open — see `TemplateScanner#quote`.
 */
type TagPart =
	| "tag-name"
	| "before-attribute-name"
	| "attribute-name"
	| "after-attribute-name"
	| "before-attribute-value"
	/** An attribute value: unquoted, or quoted while the quote is open. */
	| "value"
	| "after-attribute-value"
	/** After a `/` outside a value: only a `>` straight after it self-closes. */
	| "self-closing";

/**
 * The tokenizer states inside a `<script>`, named after the WHATWG ones.
 *
 * A script is the one raw-text element whose end is not simply its first end
 * tag. After `<!--` then `<script`, its content is "double escaped" and a
 * `</script>` there only takes it back to "escaped": the script goes on. A
 * scanner that left at the first `</script>` called the rest text, and the
 * browser ran it.
 */
type ScriptState =
	| "data"
	| "less-than"
	| "escape-start"
	| "escape-start-dash"
	| "escaped"
	| "escaped-dash"
	| "escaped-dash-dash"
	| "escaped-less-than"
	| "double-escape-start"
	| "double-escaped"
	| "double-escaped-dash"
	| "double-escaped-dash-dash"
	| "double-escaped-less-than"
	| "double-escape-end";

/**
 * Elements whose content the HTML parser does not read as markup.
 *
 * Split by WHY a slot in them is refused, because the author needs different
 * advice for each — see {@link assertBindable}.
 *
 * `code`: the content is a program (JavaScript, CSS) or cannot be escaped at
 * all. HTML escaping is meaningless there: `<script>var x = ${v}</script>`
 * puts the value in JS source, where `&lt;` is not an escape, it is a syntax
 * error.
 *
 * `text`: the content IS text and escaping it is correct — but the parser reads
 * it as RCDATA, so the `<!--$-->` boundary comments both render paths use to
 * anchor a text slot are literal characters in there. The server showed the
 * user `<!--$-->` inside the field and the browser wrote its own internal slot
 * token as the value.
 */
const RAW_TEXT_ELEMENTS: ReadonlyMap<string, "code" | "text"> = new Map([
	["script", "code"],
	["style", "code"],
	["xmp", "code"],
	["iframe", "code"],
	["noembed", "code"],
	["noframes", "code"],
	["noscript", "code"],
	["plaintext", "code"],
	["textarea", "text"],
	["title", "text"],
]);

/**
 * The elements that put the parser in FOREIGN content, where none of the
 * raw-text rules apply.
 *
 * Inside `<svg>`, `title`, `script` and `style` are ordinary elements with
 * ordinary children — the tokenizer never switches state for them. So
 * `<svg><title>${label}</title></svg>` is a perfectly good text slot, and
 * refusing it broke a chart that had been rendering for months. Found by
 * nebula's suite, not by reasoning about the spec.
 */
const FOREIGN_CONTENT_ELEMENTS: ReadonlySet<string> = new Set(["svg", "math"]);

/**
 * The elements inside foreign content whose children the parser reads as HTML
 * AGAIN — the spec calls them HTML integration points.
 *
 * Suspending the raw-text rules for everything under `<svg>` was too broad, and
 * the gap was a hole: inside `<svg><foreignObject><script>` the script is a real
 * HTML script with real raw text, and the server emitted the slot into it. What
 * made it RUN rather than merely land is worth knowing — a text slot is anchored
 * with `<!--$-->`, and inside a script `<!--` opens a legacy HTML-like comment
 * that ends at the LINE break, so a value beginning with a newline closed the
 * comment and the rest executed. Proven in Chromium before it was fixed.
 *
 * `desc` and `title` are integration points too, which is why this is a set and
 * not a special case for `foreignObject`.
 *
 * `annotation-xml` only counts when its `encoding` is `text/html` or
 * `application/xhtml+xml`. The scanner does not read attribute VALUES, so it is
 * treated as one either way: that refuses a slot MathML might have allowed, and
 * refusing too much is the direction to be wrong in.
 */
const HTML_INTEGRATION_POINTS: ReadonlySet<string> = new Set([
	// Lowercased, like every name this scanner compares.
	"foreignobject",
	"desc",
	"title",
	"annotation-xml",
	// MathML's TEXT integration points. Missing from the first list, and the gap
	// was the same hole again: `<math><mtext><script>${v}</script>` is an HTML
	// script, and it ran. The spec keeps `mglyph` and `malignmark` in MathML
	// inside them; treating those as HTML refuses more, never less.
	"mi",
	"mo",
	"mn",
	"ms",
	"mtext",
]);

/**
 * The elements whose content EXECUTES even in foreign content.
 *
 * The tokenizer does not switch state for them there — which is why
 * `<svg><title>${label}</title>` is a text slot — but that was taken to mean the
 * content was harmless, and it is not: an SVG `<script>` runs its text, and an
 * SVG `<style>` applies it. The `<!--$-->` marker did not even need a newline to
 * get out of the way, since in foreign content it is a real comment node and
 * the script's text is what is left around it. Proven in Chromium.
 */
const FOREIGN_CODE_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"]);

/**
 * The HTML start tags that end foreign content wherever they appear in it.
 *
 * The tree builder pops every SVG and MathML element off the stack when it meets
 * one of these, and reads it — and everything after it — as HTML. So after
 * `<svg><p>`, a `<textarea>` or a `<script>` is the HTML one, raw text and all,
 * though the markup still looks like it is inside the `<svg>`. `font` only does
 * it with a `color`, `face` or `size` attribute; the scanner does not read those,
 * so it always counts, which refuses more rather than less.
 */
const FOREIGN_BREAKOUT_ELEMENTS: ReadonlySet<string> = new Set([
	"b",
	"big",
	"blockquote",
	"body",
	"br",
	"center",
	"code",
	"dd",
	"div",
	"dl",
	"dt",
	"em",
	"embed",
	"font",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"head",
	"hr",
	"i",
	"img",
	"li",
	"listing",
	"menu",
	"meta",
	"nobr",
	"ol",
	"p",
	"pre",
	"ruby",
	"s",
	"small",
	"span",
	"strong",
	"strike",
	"sub",
	"sup",
	"table",
	"tt",
	"u",
	"ul",
	"var",
]);

/** The END tags that do the same: `</p>` and `</br>`. */
const FOREIGN_BREAKOUT_END_TAGS: ReadonlySet<string> = new Set(["p", "br"]);

function prefixesOf(names: Iterable<string>): Set<string> {
	return new Set(
		Array.from(names).flatMap((name) =>
			Array.from({ length: name.length }, (_, i) => name.slice(0, i + 1)),
		),
	);
}

/**
 * Prefixes of the breakout names, consulted only while in foreign content.
 *
 * Kept apart from {@link TRACKED_PREFIXES} on purpose: `div`, `span`, `p` and
 * `table` are most of a real page, and tracking their names everywhere is the
 * cost the prefix set exists to avoid. Inside an `<svg>` they are rare.
 */
const FOREIGN_BREAKOUT_PREFIXES: ReadonlySet<string> = prefixesOf(
	FOREIGN_BREAKOUT_ELEMENTS,
);

/**
 * Every prefix of those names.
 *
 * The name of a tag is only built while it could still be one of them, and this
 * is what says "could". `<td>` stops after `td`, `<span>` after `sp`, `<div>` at
 * `d` — so a page of tables and spans allocates two short strings per element
 * instead of one per letter.
 *
 * The obvious version of this test, "does it start with s, x, i, n, p or t",
 * looked like it would do the same job and did nothing at all: `tr`, `td`,
 * `table` and `span` all pass it, and they are most of a real page. Measured, not
 * assumed — `#consumeInTag` was 5.7x its old cost until this was right.
 */
/**
 * Elements whose `.value` property has a place in server-rendered markup.
 *
 * Tracked so the renderer can ask which element it is in. `textarea` is here
 * already for its raw text; `input` is only here for this.
 */
export const VALUE_BEARING_ELEMENTS: ReadonlySet<string> = new Set([
	"input",
	"textarea",
]);

const TRACKED_PREFIXES: ReadonlySet<string> = prefixesOf([
	...RAW_TEXT_ELEMENTS.keys(),
	...FOREIGN_CONTENT_ELEMENTS,
	...HTML_INTEGRATION_POINTS,
	...VALUE_BEARING_ELEMENTS,
	// Whose `src` or `data` runs what it loads — see `urlGuard.ts`.
	...SOURCE_ELEMENTS,
]);

export class TemplateScanner {
	#markup: MarkupState = "";
	/** What a declaration has read after `<!`, while it is still undecided. */
	#declaration = "";
	#inTag = false;
	/** The quote character currently open inside a tag, or empty. */
	#quote = "";
	/** Which part of the tag is being read. Only meaningful inside a tag. */
	#part: TagPart = "tag-name";
	/**
	 * The tag name being read, lowercased — but only while it could still name a
	 * raw-text element. Empty for every other tag, which is most of them.
	 */
	#tag = "";
	/** Could the name being read still be a raw-text element's? */
	#tagMayBeRaw = true;
	/** True while the tag being read is a CLOSING one, which opens nothing. */
	#closing = false;
	/** The raw-text element the cursor is inside, or empty. */
	#rawText = "";
	/** Where a `<script>`'s content stands; only read while inside one. */
	#script: ScriptState = "data";
	/** The tag name a double-escape start or end inside a script is reading. */
	#scriptBuffer = "";
	/**
	 * The open foreign-content elements and HTML integration points, innermost
	 * last. Undefined until the first one, which is most templates.
	 *
	 * A stack rather than a counter, because these nest in both directions:
	 * `<svg>` suspends the HTML rules, a `foreignObject` inside it restores them,
	 * an `<svg>` inside THAT suspends them again. A pair of counters cannot tell
	 * those apart and would refuse a slot in the innermost `<title>`.
	 */
	#modes: { name: string; mode: "foreign" | "html" | "code" }[] | undefined;
	/**
	 * Is the innermost mode foreign content (or code inside it)? Cached, because
	 * the per-character name tracking asks it and the stack only changes at the
	 * end of a tag.
	 */
	#foreign = false;
	/** Did the tag end on `/>`, as in `<desc/>`? Read by `#closeTag` only. */
	#solidus = false;
	/** The attribute name being read, or the one whose value is being read. */
	#attribute = "";
	/** How many attribute names have started — see {@link attributeCount}. */
	#attributeCount = 0;
	/**
	 * Characters of the value being read that have been consumed.
	 *
	 * Server-side rendering needs it to hold a whole attribute value back before
	 * deciding about it — `href` has to be judged complete, not one slot at a
	 * time, because `href="java${'script:alert(1)'}"` is only unsafe once the
	 * halves meet.
	 */
	#valueLength = 0;
	/**
	 * The value of the tag's `type` attribute, as read so far — undefined when
	 * the tag has none yet. Kept after the tag closes, until the next one opens.
	 *
	 * Server-side rendering needs it for `<input type="file">`, whose `.value`
	 * the client refuses: the server has to refuse it too, and `type` may come
	 * before the binding or after it.
	 */
	#type: string | undefined;
	/** Is the value being read the tag's first `type`, the one the parser keeps? */
	#readingType = false;

	/** Feed everything appended since the last call. */
	consume(chunk: string): void {
		for (let i = 0; i < chunk.length; i++) {
			const char = chunk[i];
			// `i` is bounded by the loop; naming the miss is what carries that
			// bound into the comparisons below.
			if (char === undefined) continue;
			if (this.#rawText !== "") {
				// Only this element's own end tag gets out. Everything else,
				// including a stray `<`, is content.
				const consumed =
					this.#rawText === "script"
						? this.#consumeScript(chunk, i)
						: this.#tryCloseRawText(chunk, i);
				if (consumed > 0) i += consumed - 1;
				continue;
			}
			if (this.#markup !== "") {
				this.#consumeMarkup(char);
				continue;
			}
			if (this.#quote !== "") {
				if (char === this.#quote) {
					this.#quote = "";
					this.#part = "after-attribute-value";
					this.#endAttribute();
				} else {
					this.#appendValue(char);
				}
				continue;
			}
			if (this.#inTag) {
				this.#consumeInTag(char);
				continue;
			}
			// What `<` opens depends on the character after it, which may be in the
			// next chunk — so it is a state, not a lookahead.
			if (char === "<") this.#markup = "tag-open";
		}
	}

	/**
	 * Step the tokenizer states that sit between text and a tag.
	 *
	 * They follow the spec rather than the obvious reading, because each place
	 * the two differ is a place the browser leaves a comment, or never opens a
	 * tag, while a looser scanner still thinks it is inside one — and calls a
	 * slot "text" that the browser puts in a live `<script>`. `<!-->` and
	 * `<!--->` end at once, `--!>` ends a comment as `-->` does, `<!x …`, `<?`
	 * and `</ ` end at the first `>` whatever quotes they hold, and a `<` before
	 * anything but a letter, `/`, `!` or `?` is plain text.
	 */
	#consumeMarkup(char: string): void {
		switch (this.#markup) {
			case "tag-open":
				if (isAsciiLetter(char)) {
					this.#openTag(false, char);
				} else if (char === "/") {
					this.#markup = "end-tag-open";
				} else if (char === "!") {
					this.#markup = "declaration";
					this.#declaration = "";
				} else if (char === "?") {
					this.#markup = "bogus-comment";
				} else {
					// Text after all; `<<` leaves the second one opening a tag.
					this.#markup = char === "<" ? "tag-open" : "";
				}
				return;
			case "end-tag-open":
				if (isAsciiLetter(char)) this.#openTag(true, char);
				else this.#markup = char === ">" ? "" : "bogus-comment";
				return;
			case "declaration":
				this.#consumeDeclaration(char);
				return;
			case "bogus-comment":
				if (char === ">") this.#markup = "";
				return;
			case "comment-start":
				this.#markup =
					char === "-" ? "comment-start-dash" : char === ">" ? "" : "comment";
				return;
			case "comment-start-dash":
				this.#markup =
					char === "-" ? "comment-end" : char === ">" ? "" : "comment";
				return;
			case "comment":
				if (char === "-") this.#markup = "comment-end-dash";
				return;
			case "comment-end-dash":
				this.#markup = char === "-" ? "comment-end" : "comment";
				return;
			case "comment-end":
				if (char === ">") this.#markup = "";
				else if (char === "!") this.#markup = "comment-end-bang";
				else if (char !== "-") this.#markup = "comment";
				return;
			case "comment-end-bang":
				this.#markup =
					char === "-" ? "comment-end-dash" : char === ">" ? "" : "comment";
				return;
			case "cdata":
				if (char === "]") this.#markup = "cdata-bracket";
				return;
			case "cdata-bracket":
				this.#markup = char === "]" ? "cdata-end" : "cdata";
				return;
			case "cdata-end":
				if (char === ">") this.#markup = "";
				else if (char !== "]") this.#markup = "cdata";
				return;
			case "":
				return;
		}
	}

	/**
	 * After `<!`: `--` opens a comment, `[CDATA[` a CDATA section in foreign
	 * content only, and anything else — a doctype included, which ends at its
	 * first `>` too — a bogus comment.
	 */
	#consumeDeclaration(char: string): void {
		const read = this.#declaration + char;
		if (read === "--") {
			this.#markup = "comment-start";
			return;
		}
		if (this.#foreign && read === CDATA_OPEN) {
			this.#markup = "cdata";
			return;
		}
		if (
			"--".startsWith(read) ||
			(this.#foreign && CDATA_OPEN.startsWith(read))
		) {
			this.#declaration = read;
			return;
		}
		// What was read so far holds no `>`, so only this character can end it.
		this.#markup = char === ">" ? "" : "bogus-comment";
	}

	#openTag(closing: boolean, first: string): void {
		this.#markup = "";
		this.#inTag = true;
		this.#beginTagName();
		this.#closing = closing;
		this.#attribute = "";
		this.#type = undefined;
		this.#consumeInTag(first);
	}

	/**
	 * One character inside a tag, outside a quoted value: the tokenizer's tag
	 * states, each `case` named after the state it stands for. "Reconsume" in the
	 * spec is a recursive call here, into a state that always consumes.
	 */
	#consumeInTag(char: string): void {
		switch (this.#part) {
			case "tag-name":
				// The name ends at whitespace AND at `/`: `<script/x>` is a script
				// with an attribute `x`, not an element called `scriptx`.
				if (isSpace(char)) this.#part = "before-attribute-name";
				else if (char === "/") this.#part = "self-closing";
				else if (char === ">") this.#closeTag();
				else this.#appendTagName(char);
				return;
			case "self-closing":
				if (char === ">") {
					this.#solidus = true;
					this.#closeTag();
					return;
				}
				// Only `/>` self-closes. Anything else after the `/` is an attribute
				// name — `<svg><script/ >` opens a script.
				this.#part = "before-attribute-name";
				this.#consumeInTag(char);
				return;
			case "before-attribute-name":
				if (isSpace(char)) return;
				if (char === "/") this.#part = "self-closing";
				else if (char === ">") this.#closeTag();
				// A `=` here STARTS a name, like every other character:
				// `<img ='…'>` is an attribute named `='…'`, not a value.
				else this.#beginAttribute(char);
				return;
			case "attribute-name":
				if (isSpace(char)) {
					this.#endAttributeName();
					this.#part = "after-attribute-name";
				} else if (char === "/") {
					this.#endAttributeName();
					this.#part = "self-closing";
				} else if (char === "=") {
					this.#endAttributeName();
					this.#beginValue();
				} else if (char === ">") {
					this.#endAttributeName();
					this.#closeTag();
				} else {
					this.#attribute += char;
				}
				return;
			case "after-attribute-name":
				// The name just read is kept across whitespace: `href ="x"` is the
				// value of `href`, and a guard keyed on the name must see it.
				if (isSpace(char)) return;
				if (char === "=") this.#beginValue();
				else if (char === "/") this.#part = "self-closing";
				else if (char === ">") this.#closeTag();
				else this.#beginAttribute(char);
				return;
			case "before-attribute-value":
				// Whitespace after the `=` is skipped too: `href= "x"` is `href`'s.
				if (isSpace(char)) return;
				if (char === '"' || char === "'") {
					this.#quote = char;
					this.#part = "value";
				} else if (char === ">") {
					this.#closeTag();
				} else {
					this.#part = "value";
					this.#appendValue(char);
				}
				return;
			case "value":
				// Unquoted: a quote inside it is an ordinary character (`src=a"b`).
				if (isSpace(char)) {
					this.#part = "before-attribute-name";
					this.#endAttribute();
				} else if (char === ">") {
					this.#closeTag();
				} else {
					this.#appendValue(char);
				}
				return;
			case "after-attribute-value":
				if (isSpace(char)) this.#part = "before-attribute-name";
				else if (char === "/") this.#part = "self-closing";
				else if (char === ">") this.#closeTag();
				// `a="1"b` — the tokenizer starts the next name with no whitespace.
				else this.#beginAttribute(char);
				return;
		}
	}

	#appendTagName(char: string): void {
		if (!this.#tagMayBeRaw) return;
		// Lowercased only when it has to be: a template's tag names are almost
		// always written lowercase, and `toLowerCase` allocates.
		const next =
			this.#tag + (char >= "A" && char <= "Z" ? char.toLowerCase() : char);
		if (
			TRACKED_PREFIXES.has(next) ||
			(this.#foreign && FOREIGN_BREAKOUT_PREFIXES.has(next))
		) {
			this.#tag = next;
		} else {
			this.#tagMayBeRaw = false;
		}
	}

	#appendValue(char: string): void {
		this.#valueLength += 1;
		if (this.#readingType) this.#type += char;
	}

	/** Lowercased once, at the boundary, not per character as it is read. */
	#endAttributeName(): void {
		this.#attribute = this.#attribute.toLowerCase();
	}

	#beginValue(): void {
		this.#part = "before-attribute-value";
		this.#valueLength = 0;
		// Only the first: the parser drops a repeated attribute.
		if (this.#attribute === "type" && this.#type === undefined) {
			this.#type = "";
			this.#readingType = true;
		}
	}

	/**
	 * One character of a `<script>`'s content: the tokenizer's script data
	 * states. Returns how many characters were consumed — more than one only
	 * when the script's end tag was read whole.
	 */
	#consumeScript(chunk: string, i: number): number {
		const char = chunk.charAt(i);
		switch (this.#script) {
			case "data":
				if (char === "<") {
					const closed = this.#tryCloseRawText(chunk, i);
					if (closed > 0) return closed;
					this.#script = "less-than";
				}
				return 1;
			case "less-than":
				if (char === "!") {
					this.#script = "escape-start";
					return 1;
				}
				this.#script = "data";
				return this.#consumeScript(chunk, i);
			case "escape-start":
			case "escape-start-dash":
				if (char === "-") {
					this.#script =
						this.#script === "escape-start"
							? "escape-start-dash"
							: "escaped-dash-dash";
					return 1;
				}
				this.#script = "data";
				return this.#consumeScript(chunk, i);
			case "escaped":
			case "escaped-dash":
			case "escaped-dash-dash":
				if (char === "<") {
					// An escaped script still ends at its own end tag.
					const closed = this.#tryCloseRawText(chunk, i);
					if (closed > 0) return closed;
					this.#script = "escaped-less-than";
				} else if (char === "-") {
					this.#script =
						this.#script === "escaped" ? "escaped-dash" : "escaped-dash-dash";
				} else if (char === ">" && this.#script === "escaped-dash-dash") {
					this.#script = "data";
				} else {
					this.#script = "escaped";
				}
				return 1;
			case "escaped-less-than":
				if (isAsciiLetter(char)) {
					this.#scriptBuffer = "";
					this.#script = "double-escape-start";
				} else {
					this.#script = "escaped";
				}
				return this.#consumeScript(chunk, i);
			case "double-escape-start":
			case "double-escape-end": {
				const starting = this.#script === "double-escape-start";
				if (isSpace(char) || char === "/" || char === ">") {
					// `script` toggles between the two escaped states; any other name
					// leaves the script where it was.
					const toggles = this.#scriptBuffer === "script";
					this.#script = starting === toggles ? "double-escaped" : "escaped";
					return 1;
				}
				if (isAsciiLetter(char)) {
					this.#scriptBuffer += char.toLowerCase();
					return 1;
				}
				this.#script = starting ? "escaped" : "double-escaped";
				return this.#consumeScript(chunk, i);
			}
			case "double-escaped":
			case "double-escaped-dash":
			case "double-escaped-dash-dash":
				// No end tag gets out of here: `</script>` only leads back to escaped.
				if (char === "<") {
					this.#script = "double-escaped-less-than";
				} else if (char === "-") {
					this.#script =
						this.#script === "double-escaped"
							? "double-escaped-dash"
							: "double-escaped-dash-dash";
				} else if (
					char === ">" &&
					this.#script === "double-escaped-dash-dash"
				) {
					this.#script = "data";
				} else {
					this.#script = "double-escaped";
				}
				return 1;
			case "double-escaped-less-than":
				if (char === "/") {
					this.#scriptBuffer = "";
					this.#script = "double-escape-end";
					return 1;
				}
				this.#script = "double-escaped";
				return this.#consumeScript(chunk, i);
		}
	}

	/**
	 * Leave raw text if `chunk` holds this element's end tag at `i`. Returns how
	 * many characters were consumed, or 0.
	 *
	 * The end tag is assumed not to be split across two chunks. The only way to
	 * split it is a slot inside it, which is a tag-name or attribute-name slot
	 * and refused before it gets here.
	 */
	#tryCloseRawText(chunk: string, i: number): number {
		if (chunk[i] !== "<" || chunk[i + 1] !== "/") return 0;
		// Read off the element BEFORE leaving it: every length below is its own.
		const element = this.#rawText;
		// `<plaintext>` has no end tag the parser honours: everything after it, to
		// the end of the document, is its text. Letting `</plaintext>` out made the
		// scanner place later slots in elements the browser never builds.
		if (element === "plaintext") return 0;
		const nameAt = i + 2;
		if (
			chunk.slice(nameAt, nameAt + element.length).toLowerCase() !== element
		) {
			return 0;
		}
		// A prefix is not a match: `</scriptet` does not close `<script>`.
		const after = chunk[nameAt + element.length];
		if (
			after !== undefined &&
			!isSpace(after) &&
			after !== ">" &&
			after !== "/"
		) {
			return 0;
		}
		this.#rawText = "";
		this.#inTag = true;
		this.#beginTagName();
		this.#closing = true;
		this.#attribute = "";
		this.#type = undefined;
		// `<` and `/` and the name; the terminator is read as part of the tag.
		return 2 + element.length;
	}

	/**
	 * End the tag being read: enter or leave foreign content, or enter raw text.
	 *
	 * Out of line on purpose. It runs once per ELEMENT while its caller runs once
	 * per CHARACTER, and growing the caller in place stopped the engine inlining
	 * it — measured at five times its former cost before this moved out.
	 */
	#closeTag(): void {
		this.#inTag = false;
		// `#tag` only ever holds a name worth tracking, lowercased as it was read.
		const name = this.#tagMayBeRaw ? this.#tag : "";
		if (
			this.#foreign &&
			(this.#closing
				? FOREIGN_BREAKOUT_END_TAGS.has(name)
				: FOREIGN_BREAKOUT_ELEMENTS.has(name))
		) {
			// Checked before everything else, self-closing included: `<br/>` inside
			// an `<svg>` ends it just as `<br>` does.
			this.#leaveForeignContent();
		}
		if (this.#closing) {
			// Only the element that pushed pops, so a `</title>` that closes an
			// HTML `<title>` does not unwind an `<svg>`.
			const modes = this.#modes;
			if (name !== "" && modes !== undefined) {
				const top = modes[modes.length - 1];
				if (top?.name === name) {
					modes.pop();
					this.#syncForeign();
				}
			}
		} else if (
			this.#solidus &&
			(this.#foreign || FOREIGN_CONTENT_ELEMENTS.has(name))
		) {
			// `<desc/>` opens nothing, so there is nothing to push. Only in foreign
			// content, and for `<svg/>` and `<math/>` themselves: on an HTML element
			// the parser IGNORES the slash, so `<script/>` opens a script whose raw
			// text runs to `</script>`. Honouring it everywhere let a slot in there.
		} else if (FOREIGN_CONTENT_ELEMENTS.has(name)) {
			this.#push(name, "foreign");
		} else if (this.#foreign) {
			// No raw text in foreign content — the tokenizer never switches — but an
			// integration point hands the content back to HTML, and a script or a
			// style still runs what it holds.
			if (HTML_INTEGRATION_POINTS.has(name)) this.#push(name, "html");
			else if (FOREIGN_CODE_ELEMENTS.has(name)) this.#push(name, "code");
		} else {
			// A start tag for one of these puts the parser in a state where `<` is
			// not markup. A CLOSING tag never does — `</script>` is how we got out.
			this.#rawText = RAW_TEXT_ELEMENTS.has(name) ? name : "";
			this.#script = "data";
		}
		this.#beginTagName();
		this.#attribute = "";
	}

	#push(name: string, mode: "foreign" | "html" | "code"): void {
		const modes = this.#modes ?? [];
		modes.push({ name, mode });
		this.#modes = modes;
		this.#syncForeign();
	}

	/**
	 * Pop every foreign element, as the tree builder does for a breakout tag:
	 * down to the nearest integration point, or out of foreign content entirely.
	 */
	#leaveForeignContent(): void {
		const modes = this.#modes;
		if (modes === undefined) return;
		while (modes.length > 0 && modes[modes.length - 1]?.mode !== "html") {
			modes.pop();
		}
		this.#syncForeign();
	}

	#syncForeign(): void {
		const modes = this.#modes;
		const top = modes === undefined ? undefined : modes[modes.length - 1];
		this.#foreign = top !== undefined && top.mode !== "html";
	}

	/** The foreign script or style the cursor is directly inside, or empty. */
	#foreignCode(): string {
		const modes = this.#modes;
		const top = modes === undefined ? undefined : modes[modes.length - 1];
		return top?.mode === "code" ? top.name : "";
	}

	#beginTagName(): void {
		this.#solidus = false;
		this.#part = "tag-name";
		this.#tag = "";
		this.#tagMayBeRaw = true;
		this.#closing = false;
		this.#readingType = false;
	}

	/** Start a new attribute whose name begins with `first`. */
	#beginAttribute(first: string): void {
		this.#part = "attribute-name";
		this.#attribute = first;
		this.#attributeCount += 1;
		this.#readingType = false;
	}

	/** The value just read is over; no attribute is open until the next name. */
	#endAttribute(): void {
		this.#attribute = "";
		this.#readingType = false;
	}

	/**
	 * Forget the attribute whose value has just opened: the renderer is leaving
	 * it out of the markup, so the rest of the tag reads as if it never started.
	 * The closing quote, if any, is the renderer's to drop as well.
	 */
	discardAttribute(): void {
		if (this.#readingType) this.#type = undefined;
		this.#quote = "";
		this.#part = "before-attribute-name";
		this.#endAttribute();
	}

	/** The kind of position the cursor is in right now. */
	get position(): SlotPosition {
		if (this.#rawText !== "" || this.#foreignCode() !== "") return "raw-text";
		if (this.#markup === "tag-open" || this.#markup === "end-tag-open") {
			return "tag-name";
		}
		if (this.#markup !== "") return "comment";
		if (!this.#inTag) return "text";
		if (this.#quote !== "") return "quoted-value";
		switch (this.#part) {
			case "tag-name":
				return "tag-name";
			case "before-attribute-value":
			case "value":
				// Right after the `=`, whitespace or not, a slot IS the value: the
				// tokenizer skips the whitespace and starts the value with it.
				return "unquoted-value";
			default:
				// Before, in or after a name, after a value's closing quote, after a
				// `/`: whatever comes next starts an attribute name.
				return "attribute-name";
		}
	}

	/**
	 * How many attribute names the scanner has started reading, ever. A caller
	 * that feeds one character at a time compares it before and after to learn
	 * where a name began — which is how a directive's spelling is found without
	 * a second, looser reading of the markup.
	 */
	get attributeCount(): number {
		return this.#attributeCount;
	}

	/**
	 * Is the cursor inside an unquoted value that has begun? Not right after the
	 * `=`, where the value has not started yet.
	 */
	get inUnquotedValue(): boolean {
		return this.#inTag && this.#quote === "" && this.#part === "value";
	}

	/**
	 * The element whose tag is being read, lowercased — or empty when it is not
	 * one this scanner tracks, which is most of them.
	 */
	get element(): string {
		return this.#tagMayBeRaw ? this.#tag : "";
	}

	/** Is the cursor inside a tag, anywhere between `<` and `>`? */
	get inTag(): boolean {
		return this.#inTag;
	}

	/**
	 * The raw-text element the cursor is inside, and what kind, or undefined. An
	 * SVG or MathML script or style counts, as code: its content is markup to the
	 * tokenizer, but it runs all the same.
	 */
	get rawText(): { name: string; kind: "code" | "text" } | undefined {
		if (this.#rawText === "") {
			const code = this.#foreignCode();
			return code === "" ? undefined : { name: code, kind: "code" };
		}
		const kind = RAW_TEXT_ELEMENTS.get(this.#rawText);
		return kind === undefined ? undefined : { name: this.#rawText, kind };
	}

	/**
	 * The attribute whose value the cursor is in, lowercased — HTML attribute
	 * names are case-insensitive, and a guard that compares them must be too.
	 * Empty when the cursor is not in a value.
	 */
	get attribute(): string {
		return this.#attribute;
	}

	/**
	 * The `type` attribute of the tag being read, or of the last one closed —
	 * undefined when it has none. Its markup as written, not decoded.
	 */
	get type(): string | undefined {
		return this.#type;
	}

	/** Characters of the value currently being read that have been consumed. */
	get valueLength(): number {
		return this.#valueLength;
	}

	/**
	 * Index in `chunk` of the character that would END the value now open, or -1
	 * if the value runs past the chunk. Reads nothing, changes nothing.
	 *
	 * A lookahead rather than a simulation, because the rule is small: a quoted
	 * value ends at its own quote, and an unquoted one at whitespace or `>`. It
	 * exists so a caller holding a value back can split a chunk in one step
	 * instead of feeding it a character at a time — which it used to do, and
	 * which cost 2.3x on a page full of links.
	 */
	valueEndIn(chunk: string): number {
		if (this.#quote !== "") return chunk.indexOf(this.#quote);
		if (this.#part !== "value") return -1;
		for (let i = 0; i < chunk.length; i++) {
			const char = chunk.charAt(i);
			if (char === ">" || isSpace(char)) return i;
		}
		return -1;
	}
}

/**
 * Refuse every position a slot must not land in, and narrow the rest.
 *
 * Takes the scanner rather than a position, because three of the refusals turn
 * on WHICH attribute the value belongs to, and the scanner is what knows.
 *
 * Two families, and it is worth keeping them apart.
 *
 * A tag name and an attribute name CANNOT WORK. The template is compiled ONCE
 * into a DOM fragment and the slots are node positions in it, so a name is not
 * a position. Neither ever did: a tag name threw an internal-invariant error
 * that told the author nothing, and an attribute name silently emitted
 * `html.ts`'s own `__aurora_slot_N__` token AS the attribute, with the intended
 * name landing in its value. Server-side rendering spliced both in RAW, so
 * `<${x}>` emitted whatever it was given and `<img ${x}="v">` turned a value
 * into `onerror`, carrying the handler written beside it.
 *
 * The rest CANNOT BE ESCAPED. Escaping is per context and there is no escaping
 * for these: an `on*` attribute's value is JavaScript, `srcdoc` is a whole HTML
 * document the iframe parses after decoding entities, and a raw-text element's
 * content is either a program or text the `<!--$-->` slot markers cannot live
 * in. Every one of them rendered something that ran or something visibly wrong,
 * on both paths.
 */
export function assertBindable(scanner: TemplateScanner): BindablePosition {
	const position = scanner.position;
	if (position === "tag-name") {
		throw new E_AURORA_SLOT_IN_TAG_NAME();
	}
	if (position === "attribute-name") {
		throw new E_AURORA_SLOT_IN_ATTRIBUTE_NAME();
	}
	if (position === "raw-text") {
		throw new E_AURORA_SLOT_IN_RAW_TEXT([rawTextMessage(scanner)]);
	}
	if (position === "comment") {
		// Not merely useless: both paths anchor a text slot with a comment, and its
		// `-->` ends the one it sits in. The browser then reads the rest of the
		// author's comment as markup — a `<script>` in it included — while the
		// scanner, still inside the comment, calls every slot there text.
		throw new E_AURORA_SLOT_IN_COMMENT();
	}
	assertBindableAttribute(scanner.element, scanner.attribute);
	return position;
}

/**
 * Refuse a slot in the value of an attribute that cannot be escaped or that
 * loads code: `on*`, `srcdoc`, `<base href>`, `<script src>`.
 *
 * Apart from {@link assertBindable} so the DOM path can ask it again with the
 * names the PARSER gave the element and the attribute. The scanner is written
 * to agree with the tokenizer, and each time it did not, the name it read was
 * not the browser's and the refusal stood down. Asked twice, the two readings
 * have to be wrong the same way for a slot to get through.
 */
export function assertBindableAttribute(
	element: string,
	attribute: string,
): void {
	const name = attribute.toLowerCase();
	if (name.startsWith("on")) {
		throw new E_AURORA_SLOT_IN_EVENT_ATTRIBUTE([name, name.slice(2)]);
	}
	if (name === "srcdoc") {
		throw new E_AURORA_SLOT_IN_SRCDOC();
	}
	const tag = element.toLowerCase();
	if (tag === "base" && name === "href") {
		throw new E_AURORA_SLOT_IN_BASE_URL();
	}
	if (tag === "script" && SCRIPT_SOURCE_ATTRIBUTES.has(name)) {
		throw new E_AURORA_SLOT_IN_SCRIPT_SOURCE([
			`a ${INTERPOLATION} cannot go in "${name}"`,
		]);
	}
}

/**
 * The attributes a `<script>` loads its code from: `src` in HTML, `href` and
 * `xlink:href` on an SVG script.
 *
 * Neutralising the executing schemes was not enough here. Every URL in this
 * position is code with the page's authority — `https://` on another origin
 * runs, and so does a `blob:` this page minted from someone's upload — and no
 * scheme test tells the script the author meant from one a value chose. A
 * refusal, where an `<img src>` or an `<a href>` only needs the scheme checked.
 */
const SCRIPT_SOURCE_ATTRIBUTES: ReadonlySet<string> = new Set([
	"src",
	"href",
	"xlink:href",
]);

/**
 * The properties that parse what they are given as HTML — lowercased, since the
 * check is on the name as written and `.innerhtml` is only harmless by accident.
 */
const HTML_PARSING_PROPERTIES: ReadonlySet<string> = new Set([
	"innerhtml",
	"outerhtml",
	"srcdoc",
]);

/**
 * Refuse a `.prop` binding to a property that parses its value as HTML.
 *
 * `.innerHTML=${v}` bypassed every escape aurora has: the value went through
 * `Reflect.set` and the browser parsed it as live markup, `onerror` and all. It
 * was harmless until property names kept their case — before that it set an own
 * property called `innerhtml` — and then it was a hole on both render paths.
 * `srcdoc` is refused as an attribute for the same reason; this is its other
 * spelling.
 */
export function assertBindableProperty(
	element: string,
	property: string,
): void {
	const name = property.toLowerCase();
	if (HTML_PARSING_PROPERTIES.has(name)) {
		throw new E_AURORA_SLOT_IN_HTML_PROPERTY([property]);
	}
	if (element.toLowerCase() === "base" && name === "href") {
		throw new E_AURORA_SLOT_IN_BASE_URL();
	}
	if (element.toLowerCase() === "script" && name === "src") {
		throw new E_AURORA_SLOT_IN_SCRIPT_SOURCE([`cannot bind .${property}`]);
	}
	if (
		FOREIGN_CODE_ELEMENTS.has(element.toLowerCase()) &&
		CONTENT_PROPERTIES.has(name)
	) {
		throw new E_AURORA_SLOT_IN_RAW_TEXT([
			`[aurora] cannot bind .${property} on <${element}> — that writes the ${element}'s source, and the browser runs it once the element is in the document. It is the property spelling of a slot inside <${element}>, refused for the same reason.`,
		]);
	}
}

/**
 * Refuse a value the element will not take, before the DOM refuses it less
 * helpfully.
 *
 * A file input's `.value` can only be cleared: the browser throws
 * `InvalidStateError` for anything but `""`, on every path, and the attribute
 * the server writes is ignored. Thrown by aurora instead so the error names the
 * binding and says what to do. The type is read from the attribute, as the
 * browser reads it — `.type` would need the element to be an `<input>` first.
 */
export function assertPropertyValue(
	element: Element,
	property: string,
	value: unknown,
): void {
	if (property !== "value") return;
	assertNotMarkup(value);
	if (element.localName === "input") {
		assertInputValue(element.getAttribute("type"), value);
	}
}

/**
 * Refuse a nested template where only a string can go: an attribute value or
 * `.value`.
 *
 * Markup has no meaning there, and the two paths each did something wrong with
 * it. The server spliced the template's markup into the value as is — escaped
 * for TEXT, so a quote in the data ended the attribute and the rest of it became
 * a handler, live before hydration — and the client wrote "[object Object]".
 * Arrays are searched, since the server joins one into the value.
 */
export function assertNotMarkup(value: unknown): void {
	if (!holdsTemplate(value)) return;
	throw new E_AURORA_TEMPLATE_IN_ATTRIBUTE();
}

function holdsTemplate(value: unknown): boolean {
	if (isTemplateResult(value)) return true;
	return Array.isArray(value) && value.some(holdsTemplate);
}

/**
 * Refuse a `.value` that an `<input>` of this `type` cannot take. The client
 * reads `type` off the element; server-side rendering, which has none, off the
 * scanner — one rule for both, so neither path renders what the other refuses.
 */
export function assertInputValue(
	type: string | null | undefined,
	value: unknown,
): void {
	if (
		type?.trim().toLowerCase() === "file" &&
		value !== null &&
		value !== undefined &&
		String(value) !== ""
	) {
		throw new E_AURORA_FILE_INPUT_VALUE([String(value)]);
	}
}

/**
 * The properties that write an element's text — harmless on a `<p>`, and the
 * whole program on a `<script>`. `.textContent`, `.text` and `.innerText` each
 * ran in Chromium once the script was inserted; the slot inside `<script>` they
 * stand in for was already refused.
 */
const CONTENT_PROPERTIES: ReadonlySet<string> = new Set([
	"text",
	"textcontent",
	"innertext",
]);

function rawTextMessage(scanner: TemplateScanner): string {
	const raw = scanner.rawText;
	const name = raw?.name ?? "this element";
	if (raw?.kind === "text") {
		// `textarea` and `title`: the content is text, and escaping it is right.
		// What cannot be there is the marker pair both paths use to anchor a text
		// slot — the parser reads it as content, so the server showed the user
		// `<!--$-->` and the browser wrote its own slot token as the value.
		return `[aurora] a ${INTERPOLATION} cannot go inside <${name}> — the parser reads its content as text, including the comments aurora anchors a slot with. Bind the property instead: <${name} .value="\${value}">.`;
	}
	return `[aurora] a ${INTERPOLATION} cannot go inside <${name}> — its content is not markup, so escaping it as HTML neither protects it nor keeps it valid. Build the value outside the template and pass it in another way.`;
}

/** A directive a slot is the value of, as {@link prepareTemplate} reads it. */
export interface TrailingDirective {
	/** The directive as written: `@click`, `?disabled`, `.value`. */
	readonly name: string;
	/** Its quote, `""` when unquoted. The next segment opens with it. */
	readonly quote: '"' | "'" | "";
	/** Everything the directive spans at the end of the segment, from its whitespace. */
	readonly spelling: string;
}

/** A template's strings as the server renders them, and what each slot binds. */
export interface PreparedTemplate {
	/**
	 * The strings, with every unquoted attribute value that holds a slot written
	 * between double quotes — `title=${v}` reads `title="${v}"`.
	 */
	readonly strings: readonly string[];
	/** Per slot: the directive it is the value of, or undefined. */
	readonly directives: readonly (TrailingDirective | undefined)[];
}

const PREPARED = new WeakMap<readonly string[], PreparedTemplate>();

/**
 * Read a template once, with the scanner, for what every path asks of its
 * strings: which slots are directives, and how the server writes an unquoted
 * value. Cached per strings array, like the DOM path's compiled template.
 *
 * Directives used to be found by a regular expression on the end of each
 * segment, a second reading of the markup that the scanner did not share:
 * `@click ="${h}"` or `x="1"@click="${h}"` were directives to the browser and
 * plain attributes to the server, which then CALLED the listener to stringify
 * it. One reader, the tokenizer's, now answers both questions.
 */
export function prepareTemplate(strings: readonly string[]): PreparedTemplate {
	const cached = PREPARED.get(strings);
	if (cached !== undefined) return cached;
	const quoted = quoteSlotValues(strings);
	const prepared = { strings: quoted, directives: readDirectives(quoted) };
	PREPARED.set(strings, prepared);
	return prepared;
}

/**
 * Write every unquoted attribute value that holds a slot between double quotes.
 *
 * An unquoted value cannot be empty: the tokenizer skips whitespace after an
 * `=`, so `<div title= data-note="…">` gives `title` the text that follows, and
 * the next attribute's value — escaped for a QUOTED value, spaces left alone —
 * is read unquoted and split into attributes at each space. A slot decides at
 * render time whether its value is empty, so the template cannot be trusted to
 * stay unquoted. Written quoted, as lit's server renderer writes every attribute
 * part (`name="value"`), an empty value is `title=""` and nothing moves.
 *
 * A `"` the author left inside such a value is ordinary in an unquoted value;
 * between quotes it would end it, so it is written `&quot;`, which the browser
 * reads back to the same character.
 */
/**
 * Feed the scanner the next step of `segment` from `k`, and return what was fed.
 *
 * One character, so a caller can watch the state change at each one — except at
 * the start of an end tag inside raw text: the scanner only recognises
 * `</iframe>`, `</textarea>` or `</script>` when the tag arrives whole, so fed a
 * character at a time it never left the element, and everything after it was
 * read as the element's text (no value quoted, no directive found, no URL
 * guarded). There the tag's `</name` and the character after it go in one chunk.
 */
function feedStep(
	scanner: TemplateScanner,
	segment: string,
	k: number,
): string {
	const raw = scanner.rawText;
	const fed =
		raw !== undefined && segment.startsWith("</", k)
			? segment.slice(k, k + 3 + raw.name.length)
			: segment.charAt(k);
	scanner.consume(fed);
	return fed;
}

function quoteSlotValues(strings: readonly string[]): readonly string[] {
	const scanner = new TemplateScanner();
	const out: string[] = [];
	// Inside an unquoted value that holds a slot, now written quoted.
	let quoting = false;
	for (const [i, segment] of strings.entries()) {
		let built = "";
		// Where, in `built`, the unquoted value now open began.
		let valueAt = 0;
		for (let k = 0; k < segment.length; ) {
			const wasInValue = scanner.inUnquotedValue;
			const fed = feedStep(scanner, segment, k);
			const inValue = scanner.inUnquotedValue;
			if (wasInValue && !inValue && quoting) {
				// Whitespace or `>` ended it: the closing quote goes before.
				built += '"';
				quoting = false;
			}
			if (!wasInValue && inValue) valueAt = built.length;
			// More than one character only for a raw-text end tag, never in a value.
			built += quoting && fed === '"' ? "&quot;" : fed;
			k += fed.length;
		}
		if (
			i < strings.length - 1 &&
			!quoting &&
			scanner.position === "unquoted-value"
		) {
			if (scanner.inUnquotedValue) {
				// Begun in this segment's own text (`src=/img/${name}`): quoted from
				// its first character. It cannot have begun in an earlier segment —
				// the slot ending that one would have been inside it already.
				const value = built.slice(valueAt).replaceAll('"', "&quot;");
				built = `${built.slice(0, valueAt)}"${value}`;
			} else {
				// Right after the `=`: the slot starts the value. The scanner is told
				// a value is there, since it never reads the slot's own text.
				built += '"';
				scanner.consume("x");
			}
			quoting = true;
		}
		out.push(built);
	}
	if (quoting && out.length > 0) out[out.length - 1] += '"';
	return out;
}

function readDirectives(
	strings: readonly string[],
): (TrailingDirective | undefined)[] {
	const scanner = new TemplateScanner();
	const found: (TrailingDirective | undefined)[] = [];
	for (let i = 0; i < strings.length - 1; i++) {
		const segment = strings[i] ?? "";
		// Where the last attribute name of this segment began, if one did.
		let nameAt = -1;
		for (let k = 0; k < segment.length; ) {
			const before = scanner.attributeCount;
			const fed = feedStep(scanner, segment, k);
			if (scanner.attributeCount !== before) nameAt = k;
			k += fed.length;
		}
		found.push(directiveAt(scanner, segment, nameAt));
	}
	return found;
}

/** The directive whose value the slot after `segment` is, if it is one. */
function directiveAt(
	scanner: TemplateScanner,
	segment: string,
	nameAt: number,
): TrailingDirective | undefined {
	const position = scanner.position;
	if (position !== "quoted-value" && position !== "unquoted-value") {
		return undefined;
	}
	// The slot must open the value, of an attribute named in this segment.
	if (nameAt < 0 || scanner.valueLength !== 0) return undefined;
	const sigil = segment.charAt(nameAt);
	if (sigil !== "@" && sigil !== "?" && sigil !== ".") return undefined;
	let end = nameAt + 1;
	while (end < segment.length && !endsAttributeName(segment.charAt(end))) {
		end += 1;
	}
	let from = nameAt;
	while (from > 0 && isSpace(segment.charAt(from - 1))) from -= 1;
	const last = segment.charAt(segment.length - 1);
	const quote = position !== "quoted-value" ? "" : last === "'" ? "'" : '"';
	return {
		name: segment.slice(nameAt, end),
		quote,
		spelling: segment.slice(from),
	};
}

function endsAttributeName(char: string): boolean {
	return isSpace(char) || char === "/" || char === "=" || char === ">";
}
