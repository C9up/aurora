import { describe, expect, it } from "vitest";
import { html } from "../../src/html.js";
import { hydrate } from "../../src/hydrate.js";
import { render } from "../../src/render.js";
import { renderToString } from "../../src/ssr.js";
import { TemplateScanner } from "../../src/templateScanner.js";
import type { TemplateResult } from "../../src/types.js";

/**
 * The scanner follows the HTML tokenizer on where comments, bogus comments and
 * a stray `<` end, on how a tag's name and its attributes' names are read, and
 * on where a `<script>` ends. Each divergence left it reading a slot as text, or
 * as the value of the wrong attribute, while the browser put that slot in a live
 * `<script>`, an `on*` handler, a `srcdoc` or an unguarded `href`.
 */

const JS = "\nalert(document.domain)";
const JS_URL = "javascript:alert(document.domain)";

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

/** What the browser builds from `markup`: the first element's attributes. */
function attributesOf(markup: string): Record<string, string> {
	const template = document.createElement("template");
	template.innerHTML = markup;
	const element = template.content.firstElementChild;
	return Object.fromEntries(
		Array.from(element?.attributes ?? []).map((a) => [a.name, a.value]),
	);
}

describe("templateScanner > an attribute's name, as the tokenizer reads it", () => {
	it("keeps the name across whitespace before the `=`, and after it", () => {
		for (const make of [
			() => html`<a href ="${JS_URL}">x</a>`,
			() => html`<a href	="${JS_URL}">x</a>`,
			() => html`<a href
				="${JS_URL}">x</a>`,
			() => html`<a href= "${JS_URL}">x</a>`,
			() => html`<a href = "${JS_URL}">x</a>`,
			() => html`<a href = ${JS_URL}>x</a>`,
			() => html`<a HREF ='${JS_URL}'>x</a>`,
		]) {
			const out = renderToString(make());
			expect(attributesOf(out).href).toBe(`unsafe:${JS_URL}`);
			const host = document.createElement("div");
			render(make(), host);
			expect(host.querySelector("a")?.getAttribute("href")).toBe(
				`unsafe:${JS_URL}`,
			);
		}
		expect(
			attributesOf(renderToString(html`<form action ="${JS_URL}"></form>`))
				.action,
		).toBe(`unsafe:${JS_URL}`);
		expect(
			attributesOf(renderToString(html`<iframe src ="${JS_URL}"></iframe>`))
				.src,
		).toBe(`unsafe:${JS_URL}`);
	});

	it("keeps the link inert after hydration", () => {
		for (const view of [
			() => html`<a href ="${JS_URL}">x</a>`,
			() => html`<a href ="${() => JS_URL}">x</a>`,
		]) {
			const host = document.createElement("div");
			host.innerHTML = renderToString(view());
			hydrate(host, view);
			expect(host.querySelector("a")?.getAttribute("href")).toBe(
				`unsafe:${JS_URL}`,
			);
		}
	});

	it("refuses on*, srcdoc, script src and base href whatever the spacing", () => {
		const value = "https://evil.example/x";
		refusedOnBothPaths(
			() => html`<b onclick ="${value}">x</b>`,
			"E_AURORA_SLOT_IN_EVENT_ATTRIBUTE",
		);
		refusedOnBothPaths(
			() => html`<b onclick= "${value}">x</b>`,
			"E_AURORA_SLOT_IN_EVENT_ATTRIBUTE",
		);
		refusedOnBothPaths(
			() => html`<iframe srcdoc ="${value}"></iframe>`,
			"E_AURORA_SLOT_IN_SRCDOC",
		);
		refusedOnBothPaths(
			() => html`<script src ="${value}"></script>`,
			"E_AURORA_SLOT_IN_SCRIPT_SOURCE",
		);
		refusedOnBothPaths(
			() => html`<base href ="${value}">`,
			"E_AURORA_SLOT_IN_BASE_URL",
		);
		// And at hydration, which compiles the same template.
		const host = document.createElement("div");
		host.innerHTML = '<b onclick="x">x</b>';
		expect(
			codeOf(() => hydrate(host, () => html`<b onclick ="${value}">x</b>`)),
		).toBe("E_AURORA_SLOT_IN_EVENT_ATTRIBUTE");
	});

	it("ends a name at `/`, and starts one with a leading `=`", () => {
		expect(
			attributesOf(renderToString(html`<a x/href="${JS_URL}">x</a>`)).href,
		).toBe(`unsafe:${JS_URL}`);
		refusedOnBothPaths(
			() => html`<b x/onclick="${"alert(1)"}">x</b>`,
			"E_AURORA_SLOT_IN_EVENT_ATTRIBUTE",
		);
		// `='…'` is a NAME to the tokenizer: a slot in it is a slot in a name.
		refusedOnBothPaths(
			() => html`<img ='${"x onerror=alert(1) "}'>`,
			"E_AURORA_SLOT_IN_ATTRIBUTE_NAME",
		);
		// A name that follows a closing quote with no whitespace is a name too.
		refusedOnBothPaths(
			() => html`<b x="1"onclick="${"alert(1)"}">x</b>`,
			"E_AURORA_SLOT_IN_EVENT_ATTRIBUTE",
		);
	});

	it('reads a static `name= "…"` value whole, so a later slot keeps its attribute', () => {
		const stored = 'x" onmouseover="alert(document.domain)';
		for (const make of [
			() => html`<b class= "[&>svg]:size-4" data-label="${stored}">x</b>`,
			() => html`<b title = "a > b" data-label="${stored}">x</b>`,
			() => html`<b title=
				"a > b" data-label="${stored}">x</b>`,
		]) {
			const attributes = attributesOf(renderToString(make()));
			expect(attributes["data-label"]).toBe(stored);
			expect(attributes.onmouseover).toBeUndefined();
		}
		const swallowed = attributesOf(
			renderToString(html`<a title= "a='b" href="${JS_URL}">x</a>`),
		);
		expect(swallowed.title).toBe("a='b");
		expect(swallowed.href).toBe(`unsafe:${JS_URL}`);
		expect(
			attributesOf(renderToString(html`<a title= "a=" href="${JS_URL}">x</a>`))
				.href,
		).toBe(`unsafe:${JS_URL}`);
	});

	it("sees a directive whatever the spacing, so the server never calls a listener", () => {
		let calls = 0;
		const handler = (): void => {
			calls += 1;
		};
		for (const make of [
			() => html`<button @click ="${handler}">x</button>`,
			() => html`<button @click= "${handler}">x</button>`,
			() => html`<button x="1"@click="${handler}">x</button>`,
			() => html`<button @click=${handler}>x</button>`,
		]) {
			const out = renderToString(make());
			expect(out).not.toContain("@click");
			const host = document.createElement("div");
			render(make(), host);
			host.querySelector("button")?.click();
		}
		// Four clicks in the DOM, none on the server.
		expect(calls).toBe(4);
	});

	it("reads a `.prop` name as written, spacing and all", () => {
		const host = document.createElement("div");
		render(html`<p .textContent ="${"set"}"></p>`, host);
		expect(host.querySelector("p")?.textContent).toBe("set");
	});
});

describe("templateScanner > a tag's name ends at `/`", () => {
	it("refuses a slot in `<script/x>` and `<style/x>`", () => {
		refusedOnBothPaths(
			() => html`<script/x>${JS}</script>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
		refusedOnBothPaths(
			() => html`<style/x>${"*{}"}</style>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
		refusedOnBothPaths(
			() => html`<SCRIPT/x y>${JS}</script>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});

	it("guards `<iframe/x src>`", () => {
		expect(
			attributesOf(renderToString(html`<iframe/x src="${JS_URL}"></iframe>`))
				.src,
		).toBe(`unsafe:${JS_URL}`);
	});

	it("still self-closes `<svg/>` only on `/>`", () => {
		// `<svg/ >` is an svg left open: the `<script>` in it is an SVG script.
		refusedOnBothPaths(
			() => html`<svg/ ><script>${JS}</script></svg>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
		const closed = renderToString(html`<svg/><p>${"t"}</p>`);
		expect(closed).toBe("<svg/><p><!--$-->t<!--/$--></p>");
	});
});

describe("templateScanner > a `<script>` ends where the tokenizer ends it", () => {
	it("is not ended by `</script>` while double escaped", () => {
		refusedOnBothPaths(
			() => html`<script><!--<script></script>${JS}</script>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
		refusedOnBothPaths(
			() => html`<script><!-- <script type="x"> </script > ${JS}</script>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});

	it("is ended by `</script>` when only escaped, or once the double escape closes", () => {
		for (const make of [
			() => html`<script><!-- a </script><p>${"t"}</p>`,
			() => html`<script><!--<script></script>--></script><p>${"t"}</p>`,
			() => html`<script><!--<scripty></script><p>${"t"}</p>`,
			() => html`<script><!--<script>--></script><p>${"t"}</p>`,
			() =>
				html`<script><!-- <script></script> - -- > --></script><p>${"t"}</p>`,
		]) {
			const out = renderToString(make());
			const host = document.createElement("div");
			host.innerHTML = out;
			expect(host.querySelector("p")?.textContent).toBe("t");
			expect(host.querySelectorAll("script")).toHaveLength(1);
		}
	});

	it("leaves a script on `<!` that opens no comment", () => {
		const out = renderToString(html`<script>a<!b <!-x</script><p>${"t"}</p>`);
		expect(out).toContain("<p><!--$-->t<!--/$--></p>");
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
		" href",
		" href ",
		"=",
		" =",
		"= ",
		"/",
		"/x",
		"<a ",
		"<script/x>",
		"<!--<script>",
		"\n",
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

	/**
	 * Where parse5 put the value: an attribute (by name), a text node (by
	 * parent), or nowhere — a repeated attribute is dropped by the parser.
	 */
	function placeOf(markup: string, probe: string): string {
		const template = document.createElement("template");
		template.innerHTML = markup;
		const walker = document.createTreeWalker(template.content);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node instanceof Element) {
				for (const attr of Array.from(node.attributes)) {
					if (attr.value.includes(probe)) return `attribute ${attr.name}`;
				}
			} else if (node.nodeValue?.includes(probe)) {
				return node.nodeType === 3 ? "text" : "comment";
			}
		}
		return "nowhere";
	}

	it("places every slot it accepts where parse5 places it", () => {
		const random = prng(20261124);
		const pick = (): string =>
			PIECES[Math.floor(random() * PIECES.length)] ?? "";
		// A URL, with what it takes to split an attribute that is read unquoted.
		const value = `${JS_URL}${SENTINEL} onmouseover=zq9 x`;
		const disagreements: string[] = [];
		for (let run = 0; run < 3000; run++) {
			let before = "";
			const length = 1 + Math.floor(random() * 6);
			for (let k = 0; k < length; k++) before += pick();
			let after = "";
			for (let k = 0; k < 2; k++) after += pick();
			const strings = Object.assign([before, after], { raw: [before, after] });
			let markup: string;
			try {
				markup = renderToString(html(strings, value));
			} catch {
				continue;
			}
			const scanner = new TemplateScanner();
			scanner.consume(before);
			const position = scanner.position;
			const expected =
				position === "text" ? "text" : `attribute ${scanner.attribute}`;
			const found = placeOf(markup, SENTINEL);
			const template = document.createElement("template");
			template.innerHTML = markup;
			const split = template.content.querySelector("[onmouseover]") !== null;
			const live = Array.from(template.content.querySelectorAll("[href]")).some(
				(el) => el.getAttribute("href")?.startsWith("javascript:"),
			);
			if ((found !== expected && found !== "nowhere") || split || live) {
				disagreements.push(
					`${before}\${}${after} -> ${found}, not ${expected}`,
				);
			}
		}
		expect(disagreements).toEqual([]);
	});
});
