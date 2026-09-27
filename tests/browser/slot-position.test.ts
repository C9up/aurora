import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, hydrate, renderToString, signal } from "../../src/index.js";

/**
 * Real-Chromium proof for the two slot positions that survived: an unquoted
 * attribute value, and one that follows a static value containing a `>`.
 *
 * Both were divergences between the two render paths, and both are about what a
 * PARSER does with the markup — which is exactly what happy-dom is too lenient
 * to settle. The server now encodes an unquoted value's terminators as character
 * references, and the claim that this is safe rests entirely on a real tokenizer
 * decoding them inside an unquoted attribute value. And the `>` case broke the
 * client's own template parsing, so the fix has to hold in the parser that
 * actually builds the template.
 *
 * Hydration is run in both, silently: a value that crosses as different bytes
 * but the same string is only proven by the pass that compares them.
 */

let container: HTMLElement;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warnSpy.mockRestore();
	container.remove();
});

function auroraWarnings(): string[] {
	return warnSpy.mock.calls
		.map((c: unknown[]) => String(c[0]))
		.filter((m: string) => m.includes("[aurora]"));
}

describe("aurora > browser > an unquoted attribute value", () => {
	it("does not become a second attribute, whatever is in it", () => {
		// The server used to emit `<img src=x onerror=alert(1)>` from this — one
		// attribute in, two out, and Chromium would have armed the handler.
		const factory = () => html`<img alt="k" src=${"x onerror=alert(1)"}>`;
		container.innerHTML = renderToString(factory());
		const img = container.querySelector("img");
		if (img === null) throw new Error("expected the SSR img");
		expect(img.getAttributeNames().sort()).toEqual(["alt", "src"]);
		expect(img.getAttribute("onerror")).toBeNull();
		// Nothing was armed: the browser's own view of the handler, not the markup.
		expect(img.onerror).toBeNull();
	});

	it("decodes its character references back to the value it was given", () => {
		// The whole safety argument is that `&#32;` reaches the DOM as a space
		// inside an UNQUOTED value. Only a real tokenizer settles that.
		const value = "a > b\tc/d`e=f";
		container.innerHTML = renderToString(html`<img alt="k" src=${value}>`);
		const img = container.querySelector("img");
		if (img === null) throw new Error("expected the SSR img");
		expect(img.getAttribute("src")).toBe(value);
		expect(img.getAttribute("alt")).toBe("k");
	});

	it("hydrates without a mismatch, though the bytes differ from the client's", () => {
		const src = signal("a b c");
		const factory = () => html`<img alt="k" src=${src}>`;
		container.innerHTML = renderToString(factory());
		hydrate(container, factory);
		expect(auroraWarnings()).toEqual([]);
		const img = container.querySelector("img");
		expect(img?.getAttribute("src")).toBe("a b c");
		// And the binding is live afterwards.
		src("d e");
		expect(img?.getAttribute("src")).toBe("d e");
	});
});

describe("aurora > browser > a `>` inside a static quoted value", () => {
	it("does not swallow the bindings that follow it", () => {
		// The client read this `>` as the end of the tag and dropped `class`
		// entirely — silently, on an element where every other binding worked.
		const label = signal("X");
		const factory = () => html`<div title="a > b" class="${label}">t</div>`;
		container.innerHTML = renderToString(factory());
		hydrate(container, factory);
		expect(auroraWarnings()).toEqual([]);
		const div = container.querySelector("div");
		if (div === null) throw new Error("expected the SSR div");
		expect(div.getAttribute("title")).toBe("a > b");
		expect(div.className).toBe("X");
		label("Y");
		expect(div.className).toBe("Y");
	});

	it("keeps a following text slot bound too", () => {
		const body = signal("one");
		const factory = () => html`<div title="a > b">${body}</div>`;
		container.innerHTML = renderToString(factory());
		hydrate(container, factory);
		expect(auroraWarnings()).toEqual([]);
		const div = container.querySelector("div");
		expect(div?.textContent).toBe("one");
		body("two");
		expect(div?.textContent).toBe("two");
	});
});

describe("aurora > browser > the two refused name positions", () => {
	it("refuses a tag name and an attribute name by name", () => {
		for (const [make, code] of [
			[() => html`<${"h2"}>hi</h2>`, "E_AURORA_SLOT_IN_TAG_NAME"],
			[
				() => html`<img ${"onerror"}="${"alert(1)"}">`,
				"E_AURORA_SLOT_IN_ATTRIBUTE_NAME",
			],
		] as const) {
			// Both render paths, in the browser that used to ship the injection.
			expect(() => renderToString(make())).toThrowError();
			try {
				renderToString(make());
			} catch (error) {
				expect(Reflect.get(Object(error), "code")).toBe(code);
			}
			expect(() => hydrate(container, make)).toThrowError();
		}
	});
});
