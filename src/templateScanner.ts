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

import { AuroraError } from "./errors.js";

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
	| "raw-text";

/**
 * The positions a value can actually be written into — what is left once the
 * two name positions are refused. Naming it lets {@link assertBindable} narrow,
 * so each caller picks its escaping from a type that cannot include a position
 * it has already rejected.
 */
export type BindablePosition = Exclude<
	SlotPosition,
	"tag-name" | "attribute-name" | "raw-text"
>;

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
 * Which part of a tag the cursor is reading. One enum rather than a pair of
 * booleans, because the three parts are genuinely exclusive and the pair let a
 * tag name's own characters be mistaken for an attribute name.
 */
type TagPart = "tag-name" | "attribute-name" | "value";

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
]);

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

const TRACKED_PREFIXES: ReadonlySet<string> = new Set(
	[
		...RAW_TEXT_ELEMENTS.keys(),
		...FOREIGN_CONTENT_ELEMENTS,
		...HTML_INTEGRATION_POINTS,
		...VALUE_BEARING_ELEMENTS,
	].flatMap((name) =>
		Array.from({ length: name.length }, (_, i) => name.slice(0, i + 1)),
	),
);

export class TemplateScanner {
	#inComment = false;
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
	/** Has any character of the tag name been read yet? */
	#sawNameChar = false;
	/** True while the tag being read is a CLOSING one, which opens nothing. */
	#closing = false;
	/** The raw-text element the cursor is inside, or empty. */
	#rawText = "";
	/**
	 * The open foreign-content elements and HTML integration points, innermost
	 * last. Undefined until the first one, which is most templates.
	 *
	 * A stack rather than a counter, because these nest in both directions:
	 * `<svg>` suspends the HTML rules, a `foreignObject` inside it restores them,
	 * an `<svg>` inside THAT suspends them again. A pair of counters cannot tell
	 * those apart and would refuse a slot in the innermost `<title>`.
	 */
	#modes: { name: string; html: boolean }[] | undefined;
	/** Was the last significant character in this tag a `/`, as in `<desc/>`? */
	#solidus = false;
	/** The attribute name being read, or the one whose value is being read. */
	#attribute = "";
	/** Has anything been written into the value being read yet? */
	#valueStarted = false;
	/**
	 * Characters of the value being read that have been consumed.
	 *
	 * Server-side rendering needs it to hold a whole attribute value back before
	 * deciding about it — `href` has to be judged complete, not one slot at a
	 * time, because `href="java${'script:alert(1)'}"` is only unsafe once the
	 * halves meet.
	 */
	#valueLength = 0;

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
				const consumed = this.#tryCloseRawText(chunk, i);
				if (consumed > 0) i += consumed - 1;
				continue;
			}
			if (this.#inComment) {
				// A comment swallows everything — including a stray `<` or `>`
				// that would otherwise flip the tag state — up to `-->`.
				if (char === "-" && chunk[i + 1] === "-" && chunk[i + 2] === ">") {
					this.#inComment = false;
					i += 2;
				}
				continue;
			}
			if (this.#quote !== "") {
				if (char === this.#quote) {
					this.#quote = "";
					this.#beginAttribute();
				} else {
					this.#valueStarted = true;
					this.#valueLength += 1;
				}
				continue;
			}
			if (this.#inTag) {
				this.#consumeInTag(char);
				continue;
			}
			if (
				char === "<" &&
				chunk[i + 1] === "!" &&
				chunk[i + 2] === "-" &&
				chunk[i + 3] === "-"
			) {
				this.#inComment = true;
				i += 3;
				continue;
			}
			if (char === "<") {
				this.#inTag = true;
				this.#beginTagName();
				this.#attribute = "";
			}
		}
	}

	#consumeInTag(char: string): void {
		if (char === ">") {
			this.#closeTag();
			return;
		}
		if (isSpace(char)) {
			// Whitespace ends the tag name, a bare attribute, or an unquoted
			// value — in every case the next thing is another attribute name.
			this.#beginAttribute();
			return;
		}
		if (char === "/") {
			// The FIRST `/` of a tag opens a closing one. Checked before the
			// self-closing case, which used to swallow it — so `</svg>` stopped
			// being read as a closing tag and pushed a second `<svg>` instead,
			// leaving every following `<title>` inside foreign content.
			if (this.#part === "tag-name" && !this.#sawNameChar) {
				this.#closing = true;
				return;
			}
			// Anywhere else outside a value it self-closes the tag, so `<desc/>`
			// opens nothing to close later. Inside a value it is an ordinary
			// character — a static `src=/a/b.png` must keep it.
			if (this.#part !== "value") {
				this.#solidus = true;
				return;
			}
		}
		this.#solidus = false;
		if (this.#part === "tag-name") {
			this.#sawNameChar = true;
			if (!this.#tagMayBeRaw) return;
			// Lowercased only when it has to be: a template's tag names are almost
			// always written lowercase, and `toLowerCase` allocates.
			const next =
				this.#tag + (char >= "A" && char <= "Z" ? char.toLowerCase() : char);
			if (TRACKED_PREFIXES.has(next)) this.#tag = next;
			else this.#tagMayBeRaw = false;
			return;
		}
		if (this.#part === "attribute-name") {
			if (char === "=") {
				// Lowercased once, at the boundary, not per character as it is read.
				this.#attribute = this.#attribute.toLowerCase();
				this.#part = "value";
				this.#valueStarted = false;
				this.#valueLength = 0;
			} else {
				this.#attribute += char;
			}
			return;
		}
		// Reading a value with no quotes around it. An opening quote only counts
		// as one while the value is still empty — `src=a"b` keeps the `"`.
		if (!this.#valueStarted && (char === '"' || char === "'")) {
			this.#quote = char;
			return;
		}
		this.#valueStarted = true;
		this.#valueLength += 1;
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
		this.#sawNameChar = true;
		this.#attribute = "";
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
		if (this.#closing) {
			// Only the element that pushed pops, so a `</title>` that closes an
			// HTML `<title>` does not unwind an `<svg>`.
			const modes = this.#modes;
			if (name !== "" && modes !== undefined) {
				const top = modes[modes.length - 1];
				if (top?.name === name) modes.pop();
			}
		} else if (this.#solidus) {
			// `<desc/>` opens nothing, so there is nothing to push.
		} else if (FOREIGN_CONTENT_ELEMENTS.has(name)) {
			this.#push(name, false);
		} else if (!this.#htmlRules() && HTML_INTEGRATION_POINTS.has(name)) {
			this.#push(name, true);
		} else if (this.#htmlRules()) {
			// A start tag for one of these puts the parser in a state where `<` is
			// not markup. A CLOSING tag never does — `</script>` is how we got out —
			// and in foreign content the tokenizer never switches at all.
			this.#rawText = RAW_TEXT_ELEMENTS.has(name) ? name : "";
		}
		this.#beginTagName();
		this.#attribute = "";
	}

	#push(name: string, html: boolean): void {
		const modes = this.#modes ?? [];
		modes.push({ name, html });
		this.#modes = modes;
	}

	/** Does the parser read this position's content as HTML? */
	#htmlRules(): boolean {
		const modes = this.#modes;
		if (modes === undefined || modes.length === 0) return true;
		return modes[modes.length - 1]?.html === true;
	}

	#beginTagName(): void {
		this.#solidus = false;
		this.#part = "tag-name";
		this.#tag = "";
		this.#tagMayBeRaw = true;
		this.#sawNameChar = false;
		this.#closing = false;
	}

	#beginAttribute(): void {
		this.#part = "attribute-name";
		this.#attribute = "";
	}

	/** The kind of position the cursor is in right now. */
	get position(): SlotPosition {
		if (this.#rawText !== "") return "raw-text";
		// Inside a comment the markup is inert, so a slot there is text — it
		// renders into the comment body and binds nothing.
		if (this.#inComment) return "text";
		if (!this.#inTag) return "text";
		if (this.#quote !== "") return "quoted-value";
		if (this.#part === "tag-name") return "tag-name";
		return this.#part === "value" ? "unquoted-value" : "attribute-name";
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

	/** The raw-text element the cursor is inside, and what kind, or undefined. */
	get rawText(): { name: string; kind: "code" | "text" } | undefined {
		if (this.#rawText === "") return undefined;
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
		throw new AuroraError(
			"E_AURORA_SLOT_IN_TAG_NAME",
			`[aurora] a ${INTERPOLATION} cannot be a tag name — write the tag out, or pick between two templates.`,
		);
	}
	if (position === "attribute-name") {
		throw new AuroraError(
			"E_AURORA_SLOT_IN_ATTRIBUTE_NAME",
			`[aurora] a ${INTERPOLATION} cannot be an attribute name — write the attribute out, or bind its value.`,
		);
	}
	if (position === "raw-text") {
		throw new AuroraError("E_AURORA_SLOT_IN_RAW_TEXT", rawTextMessage(scanner));
	}
	const attribute = scanner.attribute;
	if (attribute.startsWith("on")) {
		throw new AuroraError(
			"E_AURORA_SLOT_IN_EVENT_ATTRIBUTE",
			`[aurora] a ${INTERPOLATION} cannot go in "${attribute}" — that value is JavaScript, and escaping it as HTML does not stop it running. Use @${attribute.slice(2)}=\${handler}, which binds a function instead of writing source.`,
		);
	}
	if (attribute === "srcdoc") {
		throw new AuroraError(
			"E_AURORA_SLOT_IN_SRCDOC",
			`[aurora] a ${INTERPOLATION} cannot go in "srcdoc" — the iframe decodes that value and parses it as a whole HTML document, so escaping it protects nothing. Point the iframe at a URL you serve.`,
		);
	}
	return position;
}

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
