import { describe, expect, it } from "vitest";
import { component, html, renderToString, signal } from "../../src/index.js";

describe("aurora > ssr > primitives", () => {
	it("renders a static template", () => {
		expect(renderToString(html`<p>hello</p>`)).toBe("<p>hello</p>");
	});

	it("inlines primitive text slots", () => {
		expect(renderToString(html`<p>${"world"}</p>`)).toBe("<p>world</p>");
		expect(renderToString(html`<p>count: ${42}</p>`)).toBe("<p>count: 42</p>");
	});

	it("renders null / undefined / false as an empty-text placeholder (hydration alignment)", () => {
		// Empty text slots emit a `<!---->` placeholder so the path-based
		// hydration of sibling slots stays aligned (lit-html / Solid do the
		// same). The value never leaks as the literal "null"/"false"/"undefined".
		const out = renderToString(html`<p>a${null}b${undefined}c${false}d</p>`);
		expect(out).toBe("<p>a<!---->b<!---->c<!---->d</p>");
		expect(out).not.toMatch(/null|undefined|false/);
	});

	it("escapes HTML entities in text", () => {
		expect(renderToString(html`<p>${"<script>"}</p>`)).toBe(
			"<p>&lt;script&gt;</p>",
		);
		expect(renderToString(html`<p>${"a & b"}</p>`)).toBe("<p>a &amp; b</p>");
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
		expect(renderToString(html`<p>${count}</p>`)).toBe("<p>7</p>");
	});

	it("evaluates an arrow-function slot eagerly", () => {
		const n = signal(3);
		expect(renderToString(html`<p>${() => n() * 2}</p>`)).toBe("<p>6</p>");
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

	it("ignores prop (.value) directives — props are runtime-only", () => {
		const ssr = renderToString(html`<input .value="${"hello"}" />`);
		expect(ssr).not.toContain(".value");
	});
});

describe("aurora > ssr > arrays + nested templates + components", () => {
	it("flattens arrays of TemplateResults", () => {
		const items = [html`<li>a</li>`, html`<li>b</li>`];
		expect(renderToString(html`<ul>${items}</ul>`)).toBe(
			"<ul><li>a</li><li>b</li></ul>",
		);
	});

	it("recurses into nested TemplateResults", () => {
		const inner = html`<em>${"x"}</em>`;
		expect(renderToString(html`<p>${inner}</p>`)).toBe("<p><em>x</em></p>");
	});

	it("renders components by invoking them", () => {
		const Item = component<{ label: string }>(
			({ label }) => html`<li>${label}</li>`,
		);
		const out = renderToString(
			html`<ul>${[Item({ label: "x" }), Item({ label: "y" })]}</ul>`,
		);
		expect(out).toBe("<ul><li>x</li><li>y</li></ul>");
	});

	it("components with signal() state SSR their initial value", () => {
		const Counter = component(() => {
			const n = signal(42);
			return html`<output>${n}</output>`;
		});
		expect(renderToString(Counter())).toBe("<output>42</output>");
	});
});
