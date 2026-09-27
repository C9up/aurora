import { describe, expect, it } from "vitest";
import { html } from "../../src/html.js";
import { render } from "../../src/render.js";
import { renderToString } from "../../src/ssr.js";

/**
 * The slot positions that cannot be escaped, and the one that could not be
 * classified.
 *
 * Escaping is per context, and for these there is no escaping: an `on*`
 * attribute's value is JavaScript, `srcdoc` is a whole document the iframe
 * parses after decoding entities, and a raw-text element's content is either a
 * program or text the slot markers cannot live in. Every one rendered something
 * that ran, or something visibly wrong, on BOTH paths — which is why each is
 * asserted on both.
 */

type Make = () => ReturnType<typeof html>;

function codeFromSsr(make: Make): unknown {
	try {
		renderToString(make());
	} catch (error) {
		return Reflect.get(Object(error), "code");
	}
	return expect.unreachable("SSR should have refused");
}

function codeFromClient(make: Make): unknown {
	const host = document.createElement("div");
	document.body.appendChild(host);
	try {
		render(make(), host);
	} catch (error) {
		return Reflect.get(Object(error), "code");
	} finally {
		host.remove();
	}
	return expect.unreachable("the client should have refused");
}

/** The refusal code the client gives, or undefined if it accepted the slot. */
function codeFromClientOrNull(make: Make): unknown {
	const host = document.createElement("div");
	document.body.appendChild(host);
	try {
		render(make(), host);
		return undefined;
	} catch (error) {
		return Reflect.get(Object(error), "code");
	} finally {
		host.remove();
	}
}

function refusedOnBothPaths(make: Make, code: string): void {
	expect(codeFromSsr(make)).toBe(code);
	expect(codeFromClient(make)).toBe(code);
}

describe("slot refusals > an event attribute", () => {
	it("is refused, because its value is JavaScript", () => {
		// `onerror="${user}"` was escaped as HTML and then run as source. Escaping
		// a program does not make it inert.
		refusedOnBothPaths(
			() => html`<button onclick="${"alert(1)"}">x</button>`,
			"E_AURORA_SLOT_IN_EVENT_ATTRIBUTE",
		);
		refusedOnBothPaths(
			() => html`<img src="x" onerror="${"alert(1)"}">`,
			"E_AURORA_SLOT_IN_EVENT_ATTRIBUTE",
		);
	});

	it("is refused whatever its case, and unquoted", () => {
		refusedOnBothPaths(
			() => html`<img src="x" ONERROR="${"alert(1)"}">`,
			"E_AURORA_SLOT_IN_EVENT_ATTRIBUTE",
		);
		refusedOnBothPaths(
			() => html`<img src="x" onerror=${"alert(1)"}>`,
			"E_AURORA_SLOT_IN_EVENT_ATTRIBUTE",
		);
	});

	it("names the listener syntax to use instead", () => {
		try {
			renderToString(html`<button onclick="${"x"}">y</button>`);
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(String(Reflect.get(Object(error), "message"))).toContain(
				"@click=",
			);
		}
	});

	it("leaves the directive that does this properly alone", () => {
		const noop = (): void => {};
		expect(() =>
			renderToString(html`<button @click="${noop}">x</button>`),
		).not.toThrow();
		// And an attribute that merely begins with those letters is not one.
		expect(() =>
			renderToString(html`<input onceagain="${"fine"}">`),
		).toThrowError(/cannot go in "onceagain"/);
	});
});

describe("slot refusals > srcdoc", () => {
	it("is refused, because the iframe decodes it and parses it as HTML", () => {
		// The server escaped it to `&lt;script&gt;`, which the iframe decodes back
		// before parsing — so the escaping bought nothing.
		refusedOnBothPaths(
			() => html`<iframe srcdoc="${"<script>alert(1)</script>"}"></iframe>`,
			"E_AURORA_SLOT_IN_SRCDOC",
		);
	});

	it("leaves src alone, which is a URL and is guarded as one", () => {
		expect(renderToString(html`<iframe src="${"/embed"}"></iframe>`)).toContain(
			'src="/embed"',
		);
	});
});

describe("slot refusals > a raw-text element", () => {
	it("is refused inside <script> and <style>, where the content is a program", () => {
		refusedOnBothPaths(
			() => html`<script>var x = ${"1;alert(1)"}</script>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
		refusedOnBothPaths(
			() => html`<style>${"}body{display:none"}</style>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});

	it("is refused inside <textarea> and <title>, where the markers cannot live", () => {
		// These two escape correctly — what broke was the `<!--$-->` pair aurora
		// anchors a text slot with. The parser reads it as content, so the server
		// showed the user `<!--$-->` inside the field and the browser wrote its own
		// internal slot token as the value.
		refusedOnBothPaths(
			() => html`<textarea>${"hello"}</textarea>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
		refusedOnBothPaths(
			() => html`<title>${"Page"}</title>`,
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});

	it("points a textarea at the property binding, which does work", () => {
		try {
			renderToString(html`<textarea>${"v"}</textarea>`);
			expect.unreachable("should have thrown");
		} catch (error) {
			// Written as an escaped template literal: a plain string holding `${`
			// is the accident `noTemplateCurlyInString` exists to catch, and the
			// rule is right, so the test says it differently rather than silencing.
			expect(String(Reflect.get(Object(error), "message"))).toContain(
				`.value="\${value}"`,
			);
		}
		// And that binding is accepted.
		expect(() =>
			renderToString(html`<textarea .value="${"v"}"></textarea>`),
		).not.toThrow();
	});

	it("reads a `<` inside one as content, not as a tag", () => {
		// This is what made the refusal wrong before it existed: `2 < 3` put the
		// scanner inside a phantom tag, so the slot was called an attribute name.
		expect(codeFromSsr(() => html`<textarea>2 < 3: ${"v"}</textarea>`)).toBe(
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
		expect(codeFromSsr(() => html`<script>if (a < b) ${"x"}</script>`)).toBe(
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});

	it("gets out again, so a slot after one is classified correctly", () => {
		for (const make of [
			() => html`<script>if (a < b) {}</script><p>${"AFTER"}</p>`,
			() => html`<textarea>2 < 3</textarea><p>${"AFTER"}</p>`,
			() => html`<style>a{content:"<"}</style><p>${"AFTER"}</p>`,
			() => html`<title>a < b</title><p>${"AFTER"}</p>`,
		]) {
			expect(renderToString(make())).toContain("<p><!--$-->AFTER");
		}
	});

	it("is not closed by a tag that merely starts the same way", () => {
		// `</scriptet` does not end `<script>`, so the slot is still inside it.
		expect(codeFromSsr(() => html`<script>a</scriptet>b ${"x"}</script>`)).toBe(
			"E_AURORA_SLOT_IN_RAW_TEXT",
		);
	});

	it("is not entered by a CLOSING tag of the same name", () => {
		// `</script>` opens nothing; a slot after a stray one is ordinary text.
		expect(renderToString(html`</script><p>${"AFTER"}</p>`)).toContain(
			"<p><!--$-->AFTER",
		);
	});
});

describe("slot refusals > inside SVG, where the rules do not apply", () => {
	it("accepts a slot in <svg><title>, which is an ordinary element there", () => {
		// The tokenizer never switches state in foreign content, so this is a
		// plain text slot. Refusing it broke a chart that had been rendering for
		// months — caught by nebula's suite, not by reading the spec.
		const make = () =>
			html`<svg viewBox="0 0 10 10"><title id="t">${"Revenue"}</title><rect/></svg>`;
		expect(renderToString(make())).toContain("Revenue");
		expect(codeFromClientOrNull(make)).toBeUndefined();
	});

	it("accepts one in <svg><script> and <svg><style> too", () => {
		expect(() =>
			renderToString(html`<svg><style>${".a{fill:red}"}</style></svg>`),
		).not.toThrow();
		expect(() =>
			renderToString(html`<svg><script>${"var a"}</script></svg>`),
		).not.toThrow();
	});

	it("goes back to refusing once the svg closes", () => {
		expect(
			codeFromSsr(() => html`<svg><rect/></svg><title>${"Page"}</title>`),
		).toBe("E_AURORA_SLOT_IN_RAW_TEXT");
	});

	it("handles nesting, and a stray closing tag, without losing count", () => {
		expect(() =>
			renderToString(html`<svg><svg><title>${"a"}</title></svg></svg>`),
		).not.toThrow();
		// A `</svg>` with no opener must not take the depth below zero, or the
		// next real `<svg>` would be read as ordinary content.
		expect(() =>
			renderToString(html`</svg><svg><title>${"a"}</title></svg>`),
		).not.toThrow();
	});
});

describe("slot refusals > what must keep working", () => {
	it("leaves every ordinary position alone", () => {
		expect(renderToString(html`<div class="${"a"}">${"b"}</div>`)).toContain(
			'<div class="a">',
		);
		expect(renderToString(html`<div title="${"a > b"}">x</div>`)).toContain(
			"a &gt; b",
		);
		expect(renderToString(html`<input value=${"v"}>`)).toContain("value=v");
	});

	it("renders a script or a style with no slot in it, untouched", () => {
		expect(renderToString(html`<script>var a = 1 < 2;</script>`)).toBe(
			"<script>var a = 1 < 2;</script>",
		);
		expect(renderToString(html`<style>a{color:red}</style>`)).toBe(
			"<style>a{color:red}</style>",
		);
	});
});
