import { describe, expect, it } from "vitest";
import { html } from "../../src/html.js";
import { render } from "../../src/render.js";
import { renderToString } from "../../src/ssr.js";
import type { TemplateResult } from "../../src/types.js";

/**
 * The scanner follows the HTML tokenizer on where comments, bogus comments and
 * a stray `<` end. Each divergence left it reading a slot as text while the
 * browser put that slot in a live `<script>`, an `on*` handler or a `srcdoc`.
 */

const JS = "\nalert(document.domain)";

function codeOf(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return Reflect.get(Object(error), "code");
	}
	return undefined;
}

function onClient(make: () => TemplateResult): unknown {
	const host = document.createElement("div");
	document.body.appendChild(host);
	try {
		return codeOf(() => render(make(), host));
	} finally {
		host.remove();
	}
}

function refusedOnBothPaths(make: () => TemplateResult, code: string): void {
	expect(codeOf(() => renderToString(make()))).toBe(code);
	expect(onClient(make)).toBe(code);
}

describe("templateScanner > comments end where the tokenizer ends them", () => {
	it("ends `<!-->` at once", () => {
		refusedOnBothPaths(
			() => html`<!--> <script>${JS}</script>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});

	it("ends `<!--->` at once", () => {
		refusedOnBothPaths(
			() => html`<!---> <iframe srcdoc="${"<script>alert(1)</script>"}">`,
			"E_AURORA_SLOT_IN_SRCDOC",
		);
	});

	it("ends a comment on `--!>`", () => {
		refusedOnBothPaths(
			() => html`<!-- a --!> <b onclick="${JS}">x</b>`,
			"E_AURORA_SLOT_IN_EVENT_ATTRIBUTE",
		);
	});

	it("still guards a URL after `<!-->`", () => {
		const out = renderToString(
			html`<!--> <a href="${"javascript:alert(1)"}">x</a>`,
		);
		expect(out).toContain('href="unsafe:javascript:alert(1)"');
	});

	it("keeps a comment open across `--` and `- ->`", () => {
		// Inside the comment the `<script>` is inert text, so no refusal, and the
		// slot after the real end is an ordinary text slot.
		const out = renderToString(
			html`<!-- a -- b - -> <script> --><p>${"c"}</p>`,
		);
		expect(out).toContain("<p><!--$-->c<!--/$--></p>");
		const longer = renderToString(html`<!---- <script> ----><p>${"c"}</p>`);
		expect(longer).toContain("<p><!--$-->c<!--/$--></p>");
	});
});

describe("templateScanner > bogus comments end at the first `>`", () => {
	it("ends `<!x …` at the first `>`, quotes and all", () => {
		refusedOnBothPaths(
			() => html`<!x a="> <script>${JS}</script> ">`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});

	it("ends `<?x …` at the first `>`", () => {
		refusedOnBothPaths(
			() => html`<?x a="> <script>${JS}</script> ">`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});

	it("ends `</` followed by a non-letter at the first `>`", () => {
		refusedOnBothPaths(
			() => html`</ a="> <script>${JS}</script> ">`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});

	it("ends a doctype at the first `>`, even inside its quotes", () => {
		refusedOnBothPaths(
			() => html`<!DOCTYPE x PUBLIC "> <script>${JS}</script> ">`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});

	it("reads `</>` as nothing", () => {
		refusedOnBothPaths(
			() => html`</> <script>${JS}</script>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});
});

describe("templateScanner > `<` opens a tag only before a letter", () => {
	it('reads `a < b="` as text', () => {
		refusedOnBothPaths(
			() => html`<p>a < b=" <script>${JS}</script>"</p>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});

	it("reads `<1`, `< ` and `<<` as text", () => {
		for (const make of [
			() => html`<p>1 <2 x=" <script>${JS}</script>"</p>`,
			() => html`<p>x <= y=" <script>${JS}</script>"</p>`,
			() => html`<p><<script>${JS}</script></p>`,
		]) {
			refusedOnBothPaths(make, "E_AURORA_SLOT_IN_RAW_TEXT");
		}
	});

	it("binds text after a stray `<`", () => {
		const out = renderToString(html`<p>a < b ${"x"}</p>`);
		expect(out).toBe("<p>a < b <!--$-->x<!--/$--></p>");
		const host = document.createElement("div");
		render(html`<p>a < b ${"x"}</p>`, host);
		expect(host.textContent).toBe("a < b x");
	});

	it("still refuses a slot right after `<` or `</`", () => {
		refusedOnBothPaths(() => html`<${"p"}>`, "E_AURORA_SLOT_IN_TAG_NAME");
		refusedOnBothPaths(() => html`</${"p"}>`, "E_AURORA_SLOT_IN_TAG_NAME");
	});
});

describe("templateScanner > a slot inside a comment", () => {
	it("is refused — its marker would end the comment and expose what follows", () => {
		refusedOnBothPaths(
			() => html`<!-- ${"x"} <script>${JS}</script> -->`,
			"E_AURORA_SLOT_IN_COMMENT",
		);
		refusedOnBothPaths(() => html`<!-- ${"x"} -->`, "E_AURORA_SLOT_IN_COMMENT");
		refusedOnBothPaths(() => html`<!x ${"x"} >`, "E_AURORA_SLOT_IN_COMMENT");
		refusedOnBothPaths(() => html`<!${"x"}>`, "E_AURORA_SLOT_IN_COMMENT");
	});
});

describe("templateScanner > CDATA", () => {
	it("is a section in foreign content and a bogus comment elsewhere", () => {
		// In SVG, `]]>` ends it, and the `>` inside is content.
		refusedOnBothPaths(
			() => html`<svg><![CDATA[ > ]]><script>${JS}</script></svg>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
		// In HTML the first `>` ends it.
		refusedOnBothPaths(
			() => html`<![CDATA[ x="> <script>${JS}</script>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});
});

/**
 * A differential check: random templates built from the tokens the tokenizer
 * cares about, rendered with a sentinel value, then parsed by jsdom (parse5,
 * a spec tokenizer). Whatever the scanner let through must not have landed in
 * code: a script's text, an `on*` attribute or `srcdoc`.
 */
describe("templateScanner > against a spec tokenizer", () => {
	const PIECES = [
		"<!--",
		"-->",
		"--!>",
		"<!-->",
		"<!--->",
		"-",
		"!",
		"<!x ",
		"<?",
		"</ ",
		"</>",
		"<",
		"< ",
		"<1",
		' a="',
		" b='",
		'"',
		"'",
		">",
		"<b ",
		"<b>",
		"<script>",
		"</script>",
		' onclick="',
		' srcdoc="',
		"<iframe",
		"<svg>",
		"</svg>",
		"<![CDATA[",
		"]]>",
		"text ",
		"<!DOCTYPE ",
	];
	const SENTINEL = "zq9sentinel";

	function prng(seed: number): () => number {
		let state = seed;
		return () => {
			state = (state * 1103515245 + 12345) % 2147483648;
			return state / 2147483648;
		};
	}

	// A script runs its child text content — its own Text children, not those
	// of an element nested in an SVG script.
	function inCode(node: Node): boolean {
		const name = node.parentNode?.nodeName.toLowerCase();
		return name === "script" || name === "style";
	}

	function landedInCode(markup: string): boolean {
		const template = document.createElement("template");
		template.innerHTML = markup;
		const walker = document.createTreeWalker(template.content);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node.nodeType === 3 && node.nodeValue?.includes(SENTINEL)) {
				if (inCode(node)) return true;
			}
			if (node instanceof Element) {
				for (const attr of Array.from(node.attributes)) {
					if (!attr.value.includes(SENTINEL)) continue;
					if (attr.name.startsWith("on") || attr.name === "srcdoc") return true;
				}
			}
		}
		return false;
	}

	it("never lets a slot it accepted land in code", () => {
		const random = prng(20261109);
		const pick = (): string =>
			PIECES[Math.floor(random() * PIECES.length)] ?? "";
		const escaped: string[] = [];
		for (let run = 0; run < 3000; run++) {
			let before = "";
			const length = 1 + Math.floor(random() * 6);
			for (let k = 0; k < length; k++) before += pick();
			let after = "";
			for (let k = 0; k < 2; k++) after += pick();
			const strings = Object.assign([before, after], { raw: [before, after] });
			let markup: string;
			try {
				markup = renderToString(html(strings, SENTINEL));
			} catch {
				continue;
			}
			if (landedInCode(markup)) escaped.push(`${before}\${}${after}`);
		}
		expect(escaped).toEqual([]);
	});
});
