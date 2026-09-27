import { describe, expect, it } from "vitest";
import { html } from "../../src/html.js";
import { render } from "../../src/render.js";
import { renderToString } from "../../src/ssr.js";

/**
 * Where a `${}` is allowed to land, and what happens at the four positions
 * where the two render paths used to disagree.
 *
 * Every case here was a real divergence between `html.ts` and `ssr.ts`, which
 * scanned the markup separately. Two were holes: the server spliced a tag name
 * and an attribute name in raw, and escaped an unquoted attribute value as if it
 * were quoted. Two were silent wrongness on the client: an attribute name became
 * the renderer's own slot token, and a `>` inside a static quoted value dropped
 * every following binding on that element.
 *
 * Both paths are checked for each, because their separation is exactly how they
 * came to disagree.
 */

function domValue(markup: string, attribute: string): string | null {
	const host = document.createElement("div");
	host.innerHTML = markup;
	return host.firstElementChild?.getAttribute(attribute) ?? null;
}

function renderInDom(result: ReturnType<typeof html>): string {
	const host = document.createElement("div");
	document.body.appendChild(host);
	try {
		render(result, host);
		return host.innerHTML;
	} finally {
		host.remove();
	}
}

function codeOf(work: () => unknown): unknown {
	try {
		work();
	} catch (error) {
		return Reflect.get(Object(error), "code");
	}
	return expect.unreachable("should have thrown");
}

describe("slot position > a tag name", () => {
	it("is refused at the opening tag, on both paths", () => {
		expect(() => renderToString(html`<${"h2"}>hi</h2>`)).toThrowError(
			/cannot be a tag name/,
		);
		expect(() => renderInDom(html`<${"h2"}>hi</h2>`)).toThrowError(
			/cannot be a tag name/,
		);
	});

	it("is refused at the closing tag", () => {
		expect(() => renderToString(html`<h2>hi</${"h2"}>`)).toThrowError(
			/cannot be a tag name/,
		);
	});

	it("does not render markup that arrived as a tag name", () => {
		// What the server used to emit, intact.
		expect(
			codeOf(() => renderToString(html`<${"img src=x onerror=alert(1)"}>`)),
		).toBe("E_AURORA_SLOT_IN_TAG_NAME");
	});
});

describe("slot position > an attribute name", () => {
	it("is refused, on both paths", () => {
		expect(() => renderToString(html`<img ${"alt"}="x">`)).toThrowError(
			/cannot be an attribute name/,
		);
		expect(() => renderInDom(html`<img ${"alt"}="x">`)).toThrowError(
			/cannot be an attribute name/,
		);
	});

	it("names itself, so the author can find it", () => {
		expect(codeOf(() => renderToString(html`<img ${"alt"}="x">`))).toBe(
			"E_AURORA_SLOT_IN_ATTRIBUTE_NAME",
		);
		expect(codeOf(() => renderInDom(html`<img ${"alt"}="x">`))).toBe(
			"E_AURORA_SLOT_IN_ATTRIBUTE_NAME",
		);
	});

	it("does not turn a value into a handler", () => {
		// The server used to emit `<img onerror="alert(1)">` from this.
		expect(() =>
			renderToString(html`<img ${"onerror"}="${"alert(1)"}">`),
		).toThrowError(/cannot be an attribute name/);
	});

	it("is refused mid-name too, and after an attribute that has a value", () => {
		expect(() => renderToString(html`<img data-${"k"}="v">`)).toThrowError(
			/cannot be an attribute name/,
		);
		expect(() => renderToString(html`<img alt="a" ${"id"}="b">`)).toThrowError(
			/cannot be an attribute name/,
		);
	});
});

describe("slot position > an unquoted attribute value", () => {
	it("cannot escape the attribute it is in", () => {
		// `escapeAttr` protects a QUOTED value; with no quotes the tokenizer ends
		// the value at the first space, so this used to come out of the server as
		// `<img src=x onerror=alert(1)>` — two attributes, the second a handler.
		const markup = renderToString(html`<img src=${"x onerror=alert(1)"}>`);
		expect(markup).not.toContain(" onerror");
		expect(domValue(markup, "onerror")).toBeNull();
	});

	it("keeps the value it was given, once parsed", () => {
		const value = "x onerror=alert(1)";
		const markup = renderToString(html`<img src=${value}>`);
		// Byte-different from the client's markup (character references), and
		// identical in the DOM — which is what hydration compares.
		expect(domValue(markup, "src")).toBe(value);
		expect(domValue(renderInDom(html`<img src=${value}>`), "src")).toBe(value);
	});

	it("agrees with the client on every awkward character", () => {
		for (const value of ["a > b", "/img/a.png", "a/", "a`b", "a\tb", "a=b"]) {
			const markup = renderToString(html`<img src=${value} alt="k">`);
			expect(domValue(markup, "src")).toBe(value);
			expect(
				domValue(renderInDom(html`<img src=${value} alt="k">`), "src"),
			).toBe(value);
			// The characters are encoded, so none of them reaches the markup as
			// itself and ends the attribute early.
			expect(domValue(markup, "alt")).toBe("k");
		}
	});

	it("keeps static markup that continues the value, and the tag's own solidus", () => {
		// `<img src=a/>` gives `src="a/"` in a browser — the solidus is part of an
		// unquoted value, not the tag's. Both paths reproduce that rather than
		// either one normalising, which is what keeps hydration quiet.
		for (const make of [
			() => html`<img src=${"/base"}/thumb.png>`,
			() => html`<img src=${"a"}/>`,
			() => html`<img src=${"a"} />`,
		]) {
			const parsed = domValue(renderToString(make()), "src");
			expect(parsed).toBe(domValue(renderInDom(make()), "src"));
			expect(parsed).not.toBeNull();
		}
		expect(
			domValue(renderToString(html`<img src=${"/base"}/thumb.png>`), "src"),
		).toBe("/base/thumb.png");
	});

	it("concatenates two slots in one value, the way the client does", () => {
		const markup = renderToString(html`<img src=${"a"}${"b"}>`);
		expect(domValue(markup, "src")).toBe("ab");
		expect(domValue(renderInDom(html`<img src=${"a"}${"b"}>`), "src")).toBe(
			"ab",
		);
	});

	it("leaves a quoted value quoted, not entity-encoded", () => {
		// The encoding is for the unquoted context only; a quoted value must not
		// pay for it.
		expect(renderToString(html`<img alt="${"a b"}">`)).toContain('alt="a b"');
	});
});

describe("slot position > a `>` inside a static quoted value", () => {
	it("does not end the tag on either path", () => {
		// Only the server tracked quotes. The client read this `>` as the end of
		// the tag, classified the next slot as TEXT, and silently dropped the
		// `class` binding altogether.
		const make = () => html`<div title="a > b" class="${"X"}">t</div>`;
		expect(renderToString(make())).toContain('class="X"');
		expect(renderInDom(make())).toContain('class="X"');
	});

	it("still places a following text slot correctly", () => {
		const make = () => html`<div title="a > b">${"X"}</div>`;
		expect(domValue(renderToString(make()), "title")).toBe("a > b");
		expect(renderInDom(make())).toContain("X");
	});

	it("reads a `>` inside a single-quoted value the same way", () => {
		const make = () => html`<div title='a > b' class="${"X"}">t</div>`;
		expect(renderToString(make())).toContain('class="X"');
		expect(renderInDom(make())).toContain('class="X"');
	});
});

describe("slot position > the positions that must keep working", () => {
	it("binds a quoted attribute value, and text", () => {
		expect(renderToString(html`<div class="${"a"}">${"b"}</div>`)).toContain(
			'<div class="a">',
		);
	});

	it("does not mistake a `<` in text, or one inside a comment, for a tag", () => {
		expect(renderToString(html`<p>a &lt; ${"b"}</p>`)).toContain("b");
		expect(renderToString(html`<!-- < --><p>${"c"}</p>`)).toContain("c");
		// A comment that opens a tag which never closes used to leave the SSR
		// scanner inside a tag for the rest of the template.
		expect(renderToString(html`<!-- <div --><p>${"c"}</p>`)).toContain(
			"<p><!--$-->c",
		);
	});

	it("keeps every directive working, in all three quote styles", () => {
		// The refusal above fires on an attribute-NAME position, and a directive
		// leaves the scanner in exactly that position once its prefix is stripped.
		const noop = (): void => {};
		for (const make of [
			() => html`<button @click="${noop}">x</button>`,
			() => html`<button @click='${noop}'>x</button>`,
			() => html`<button @click=${noop}>x</button>`,
			() => html`<input ?disabled="${true}">`,
			() => html`<input ?disabled=${true}>`,
			() => html`<input .value="${"v"}">`,
			() => html`<input .value=${"v"}>`,
		]) {
			expect(() => renderToString(make())).not.toThrow();
			expect(() => renderInDom(make())).not.toThrow();
		}
		expect(renderToString(html`<input ?disabled=${true}>`)).toContain(
			'disabled=""',
		);
		expect(renderToString(html`<input ?disabled=${false}>`)).not.toContain(
			"disabled",
		);
	});
});
