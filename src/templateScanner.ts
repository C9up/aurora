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
	| "unquoted-value";

/**
 * The positions a value can actually be written into — what is left once the
 * two name positions are refused. Naming it lets {@link assertBindable} narrow,
 * so each caller picks its escaping from a type that cannot include a position
 * it has already rejected.
 */
export type BindablePosition = Exclude<
	SlotPosition,
	"tag-name" | "attribute-name"
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

export class TemplateScanner {
	#inComment = false;
	#inTag = false;
	/** The quote character currently open inside a tag, or empty. */
	#quote = "";
	/** Has the tag being scanned got a name yet? */
	#named = true;
	/** Are we past the `=` of the attribute being scanned? */
	#afterEquals = false;

	/** Feed everything appended since the last call. */
	consume(chunk: string): void {
		for (let i = 0; i < chunk.length; i++) {
			const char = chunk[i];
			// `i` is bounded by the loop; naming the miss is what carries that
			// bound into the comparisons below.
			if (char === undefined) continue;
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
					// The value ended with its quote, so the next thing in the
					// tag is another attribute name.
					this.#afterEquals = false;
				}
				continue;
			}
			if (this.#inTag) {
				if (this.#afterEquals && (char === '"' || char === "'")) {
					this.#quote = char;
				} else if (char === ">") {
					this.#inTag = false;
					this.#named = true;
					this.#afterEquals = false;
				} else if (!this.#named && char !== "/") {
					// The first character after `<` or `</` begins the name.
					this.#named = true;
				} else if (char === "=") {
					this.#afterEquals = true;
				} else if (isSpace(char)) {
					// Whitespace ends an unquoted value and begins the next
					// attribute name.
					this.#afterEquals = false;
				}
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
				this.#named = false;
				this.#afterEquals = false;
			}
		}
	}

	/** The kind of position the cursor is in right now. */
	get position(): SlotPosition {
		// Inside a comment the markup is inert, so a slot there is text — it
		// renders into the comment body and binds nothing.
		if (this.#inComment) return "text";
		if (!this.#inTag) return "text";
		if (!this.#named) return "tag-name";
		if (this.#quote !== "") return "quoted-value";
		return this.#afterEquals ? "unquoted-value" : "attribute-name";
	}
}

/**
 * Refuse the two positions no render path can bind, with one message each.
 *
 * Both refusals have the same two reasons, and both are reasons to refuse
 * rather than to escape.
 *
 * It cannot work. The template is compiled ONCE into a DOM fragment and the
 * slots are node positions inside it. A tag name and an attribute name are not
 * positions — changing either would mean recompiling the template, which is the
 * one thing this design does not do. Neither ever worked: a tag name threw an
 * internal-invariant error that told the author nothing, and an attribute name
 * silently emitted `html.ts`'s own `__aurora_slot_N__` token AS the attribute,
 * with the intended name landing in its value.
 *
 * And it was not safe. Server-side rendering spliced both in RAW. `<${x}>`
 * emitted whatever it was given, and `<img ${x}="v">` turned a value into an
 * attribute NAME — `onerror`, carrying the handler written next to it. Every
 * other slot position escapes. Those two did not, and each produced a page the
 * browser then refused to hydrate, so the injection shipped and the repair never
 * ran.
 */
export function assertBindable(
	position: SlotPosition,
): asserts position is BindablePosition {
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
}
