import { describe, expect, it } from "vitest";
import { html } from "../../src/html.js";
import { render } from "../../src/render.js";
import { renderToString } from "../../src/ssr.js";

/**
 * A `${}` where a tag name goes.
 *
 * It looks like it should work, and for one render path it appeared to: the
 * server produced markup and the browser then refused to hydrate it. What the
 * server produced was the value spliced in raw, so a tag name built from
 * anything a user touched was markup injection — and because the page could
 * not hydrate, the injection shipped and nothing repaired it.
 *
 * It cannot be made to work either: the template compiles once into a fragment
 * and the slots are positions inside it. A tag name is not a position.
 */

describe("html > a slot where a tag name goes", () => {
	it("is refused at the opening tag", () => {
		expect(() => renderToString(html`<${"h2"}>hi</h2>`)).toThrowError(
			/cannot be a tag name/,
		);
	});

	it("is refused at the closing tag", () => {
		expect(() => renderToString(html`<h2>hi</${"h2"}>`)).toThrowError(
			/cannot be a tag name/,
		);
	});

	it("names itself, so the author can find it", () => {
		try {
			renderToString(html`<${"h2"}>hi</h2>`);
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(Reflect.get(Object(error), "code")).toBe(
				"E_AURORA_SLOT_IN_TAG_NAME",
			);
		}
	});

	it("does not render markup that came in as a tag name", () => {
		// What used to come out of the server, intact.
		expect(() =>
			renderToString(html`<${"img src=x onerror=alert(1)"}>hi</x>`),
		).toThrowError(/cannot be a tag name/);
	});

	it("leaves every other slot position alone", () => {
		// The regression this could easily cause: an attribute slot sits inside
		// a tag too, and must keep working.
		expect(renderToString(html`<div class="${"a"}">${"b"}</div>`)).toContain(
			'<div class="a">',
		);
		expect(renderToString(html`<div ${""}>x</div>`)).toContain("<div");
		// A `<` in text, and a comment holding one, must not look like a tag.
		expect(renderToString(html`<p>a &lt; ${"b"}</p>`)).toContain("b");
		expect(renderToString(html`<!-- < --><p>${"c"}</p>`)).toContain("c");
	});
});

describe("html > and on the client render path", () => {
	it("is refused there too, with the same name", () => {
		// The two paths have their own scanners. That is exactly how they came
		// to disagree — one threw an internal-invariant error, the other
		// shipped the injection — so both are checked here.
		const host = document.createElement("div");
		document.body.appendChild(host);
		try {
			expect(() => render(html`<${"h2"}>hi</h2>`, host)).toThrowError(
				/cannot be a tag name/,
			);
		} finally {
			host.remove();
		}
	});
});
