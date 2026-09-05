import { describe, expect, it } from "vitest";
import { component, html, renderToString, signal } from "../../src/index.js";

describe("aurora > ssr > primitives", () => {
	it("renders a static template", () => {
		expect(renderToString(html`<p>hello</p>`)).toBe("<p>hello</p>");
	});

	it("wraps primitive text slots in boundary markers", () => {
		expect(renderToString(html`<p>${"world"}</p>`)).toBe(
			"<p><!--$-->world<!--/$--></p>",
		);
		expect(renderToString(html`<p>count: ${42}</p>`)).toBe(
			"<p>count: <!--$-->42<!--/$--></p>",
		);
	});

	it("renders null / undefined / false as an empty marked slot (hydration alignment)", () => {
		// Every text slot is wrapped in a `<!--$-->…<!--/$-->` pair so sibling
		// paths stay aligned; an empty value just leaves the pair empty. The value
		// never leaks as the literal "null"/"false"/"undefined".
		const out = renderToString(html`<p>a${null}b${undefined}c${false}d</p>`);
		expect(out).toBe(
			"<p>a<!--$--><!--/$-->b<!--$--><!--/$-->c<!--$--><!--/$-->d</p>",
		);
		expect(out).not.toMatch(/null|undefined|false/);
	});

	it("escapes HTML entities in text", () => {
		expect(renderToString(html`<p>${"<script>"}</p>`)).toBe(
			"<p><!--$-->&lt;script&gt;<!--/$--></p>",
		);
		expect(renderToString(html`<p>${"a & b"}</p>`)).toBe(
			"<p><!--$-->a &amp; b<!--/$--></p>",
		);
	});

	it("escapes attribute special chars", () => {
		expect(renderToString(html`<a title="${'he said "hi"'}">x</a>`)).toBe(
			'<a title="he said &quot;hi&quot;">x</a>',
		);
	});

	it("escapes single quotes so a single-quoted attribute cannot be broken out of", () => {
		// The engine doesn't force double-quoted attributes — a `'`-quoted
		// attribute with an unescaped `'` in the value is an XSS breakout.
		const ssr = renderToString(
			html`<a title='${"' onmouseover='alert(1)"}'>x</a>`,
		);
		expect(ssr).not.toContain("onmouseover='");
		expect(ssr).toContain("&#39; onmouseover=&#39;alert(1)");
	});

	it("escapes < and > inside attribute values", () => {
		// `>` isn't required by spec inside a quoted attribute, but escaping
		// it is the only way to stay safe under stray scanners / proxies
		// that look for tag boundaries without tracking quote state.
		const ssr = renderToString(html`<a title="${"<x>&"}">x</a>`);
		expect(ssr).toContain("&lt;x&gt;&amp;");
		expect(ssr).not.toContain("<x>");
	});

	it("escapes XSS payloads across a multi-slot attribute", () => {
		const a = '"><script>alert(1)</script>';
		const b = "<img src=x onerror=evil()>";
		const ssr = renderToString(
			html`<div class="prefix ${a} mid ${b} suffix">x</div>`,
		);
		// No raw script/img/quote-escape should ever survive.
		expect(ssr).not.toMatch(/<script/i);
		expect(ssr).not.toMatch(/<img/i);
		expect(ssr).not.toContain('"><');
		// Both slot values still present, just neutered.
		expect(ssr).toContain("&lt;script&gt;");
		expect(ssr).toContain("&lt;img");
		expect(ssr).toContain("prefix ");
		expect(ssr).toContain(" mid ");
		expect(ssr).toContain(" suffix");
	});
});

describe("aurora > ssr > reactive snapshots", () => {
	it("evaluates signals once for the snapshot", () => {
		const count = signal(7);
		expect(renderToString(html`<p>${count}</p>`)).toBe(
			"<p><!--$-->7<!--/$--></p>",
		);
	});

	it("evaluates an arrow-function slot eagerly", () => {
		const n = signal(3);
		expect(renderToString(html`<p>${() => n() * 2}</p>`)).toBe(
			"<p><!--$-->6<!--/$--></p>",
		);
	});

	it("ignores event handlers (no @click in SSR markup)", () => {
		const ssr = renderToString(html`<button @click="${() => {}}">go</button>`);
		expect(ssr).not.toContain("@click");
		expect(ssr).not.toContain("function");
		expect(ssr).toBe("<button>go</button>");
	});

	it("ignores boolean-attr (?attr) directives when false", () => {
		const ssr = renderToString(html`<button ?disabled="${false}">go</button>`);
		expect(ssr).not.toContain("?disabled");
		expect(ssr).not.toContain("disabled");
	});

	it("renders a boolean attribute the server can see is true", () => {
		// The client writes `setAttribute(name, "")`; the server writes the
		// same bytes, so hydration re-applying the effect changes nothing.
		expect(renderToString(html`<button ?disabled="${true}">go</button>`)).toBe(
			'<button disabled="">go</button>',
		);
	});

	it("reads a signal and a reactive expression behind ?attr", () => {
		const open = signal(true);
		expect(renderToString(html`<dialog ?open="${open}"></dialog>`)).toBe(
			'<dialog open=""></dialog>',
		);
		open(false);
		expect(renderToString(html`<dialog ?open="${open}"></dialog>`)).toBe(
			"<dialog></dialog>",
		);
		expect(renderToString(html`<p ?hidden="${() => 1 > 2}">shown</p>`)).toBe(
			"<p>shown</p>",
		);
		expect(renderToString(html`<p ?hidden="${() => 2 > 1}">gone</p>`)).toBe(
			'<p hidden="">gone</p>',
		);
	});

	it("leaves the attribute off when the expression throws", () => {
		// Fail-soft, like every other server-side evaluation here: the client
		// effect decides once it has a DOM, rather than the page failing.
		const out = renderToString(
			html`<p ?hidden="${() => {
				throw new Error("no context yet");
			}}">text</p>`,
		);
		expect(out).toBe("<p>text</p>");
	});

	it("keeps the following slots aligned after a rendered ?attr", () => {
		// The emitted attribute moves the tag scanner, so the slot after it is
		// still classified as an attribute and not as a text region.
		expect(
			renderToString(
				html`<p ?hidden="${true}" title="${"a > b"}">${"body"}</p>`,
			),
		).toBe('<p hidden="" title="a &gt; b"><!--$-->body<!--/$--></p>');
	});

	it("ignores prop (.value) directives — props are runtime-only", () => {
		const ssr = renderToString(html`<input .value="${"hello"}" />`);
		expect(ssr).not.toContain(".value");
	});
});

describe("aurora > ssr > arrays + nested templates + components", () => {
	it("flattens arrays of TemplateResults", () => {
		const items = [html`<li>a</li>`, html`<li>b</li>`];
		expect(renderToString(html`<ul>${items}</ul>`)).toBe(
			"<ul><!--$--><li>a</li><li>b</li><!--/$--></ul>",
		);
	});

	it("recurses into nested TemplateResults (wrapped in boundary markers)", () => {
		const inner = html`<em>${"x"}</em>`;
		// A DIRECT nested template is wrapped in `<!--$-->…<!--/$-->` (like a
		// reactive structured slot) so hydration can locate its node range and
		// keep the following sibling slot paths aligned.
		expect(renderToString(html`<p>${inner}</p>`)).toBe(
			"<p><!--$--><em><!--$-->x<!--/$--></em><!--/$--></p>",
		);
	});

	it("renders components by invoking them", () => {
		const Item = component<{ label: string }>(
			({ label }) => html`<li>${label}</li>`,
		);
		const out = renderToString(
			html`<ul>${[Item({ label: "x" }), Item({ label: "y" })]}</ul>`,
		);
		expect(out).toBe(
			"<ul><!--$--><li><!--$-->x<!--/$--></li><li><!--$-->y<!--/$--></li><!--/$--></ul>",
		);
	});

	it("components with signal() state SSR their initial value", () => {
		const Counter = component(() => {
			const n = signal(42);
			return html`<output>${n}</output>`;
		});
		expect(renderToString(Counter())).toBe(
			"<output><!--$-->42<!--/$--></output>",
		);
	});
});

describe("aurora > attribute detection", () => {
	it("does not mistake a > inside an attribute value for the end of the tag", () => {
		const out = renderToString(html`<a title="a > b" href="${"/x"}">link</a>`);
		// The href value must be inlined, never wrapped in slot markers.
		expect(out).toContain('href="/x"');
		expect(out).not.toContain("<!--$-->/x");
	});

	it("handles single quotes the same way", () => {
		const out = renderToString(html`<a title='a > b' href="${"/y"}">l</a>`);
		expect(out).toContain('href="/y"');
		expect(out).not.toContain("<!--$-->/y");
	});

	it("still marks a real text slot after a closed tag", () => {
		const out = renderToString(html`<p title="a > b">${"hello"}</p>`);
		expect(out).toContain("<!--$-->hello<!--/$-->");
	});

	it("keeps its bearings across several tags and quoted angle brackets", () => {
		const out = renderToString(
			html`<i data-x="<">${"one"}</i><b class="${"c"}">${"two"}</b>`,
		);
		expect(out).toContain("<!--$-->one<!--/$-->");
		expect(out).toContain('class="c"');
		expect(out).toContain("<!--$-->two<!--/$-->");
	});
});

describe("aurora > ssr > a handler never runs on the server", () => {
	it("strips a single-quoted directive, as it does a double-quoted one", () => {
		let calls = 0;
		const handler = (): string => {
			calls++;
			return "SIDE-EFFECT";
		};

		// The scanner matched `="` only, so this form fell through to the value
		// stringifier, which CALLED the handler: a counter incremented during
		// render and `@click='SIDE-EFFECT'` written into the HTML.
		const out = renderToString(html`<button @click='${handler}'>x</button>`);

		expect(calls).toBe(0);
		expect(out).toBe("<button>x</button>");
	});

	it("does the same for .prop in single quotes, and still renders ?attr", () => {
		let propCalls = 0;
		const prop = (): string => {
			propCalls++;
			return "typed";
		};

		const out = renderToString(
			html`<input ?disabled='${() => true}' .value='${prop}'>`,
		);

		// A property has no markup — reading it server-side would run author
		// code for a value that cannot be serialised anyway.
		expect(propCalls).toBe(0);
		// A boolean attribute does, and single quoting must not change that.
		expect(out).toBe('<input disabled="">');
	});

	it("keeps evaluating a reactive expression in text position", () => {
		// The legitimate case, unchanged: a function in a text slot IS the
		// reactive expression and is evaluated server-side.
		expect(renderToString(html`<p>${() => 6 * 7}</p>`)).toContain("42");
	});

	it("keeps evaluating a reactive expression in an attribute", () => {
		// The legitimate attribute case, and why a blanket "never call a
		// function in an attribute" guard is wrong: this is how a class list is
		// computed server-side.
		expect(
			renderToString(html`<aside class="${() => "w-16"}"></aside>`),
		).toContain('class="w-16"');
	});

	it("strips an unquoted directive too", () => {
		let calls = 0;
		const handler = (): string => {
			calls++;
			return "SIDE-EFFECT";
		};

		expect(renderToString(html`<button @click=${handler}>x</button>`)).toBe(
			"<button>x</button>",
		);
		expect(calls).toBe(0);
	});
});
