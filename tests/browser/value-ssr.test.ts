import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, hydrate, renderToString, signal } from "../../src/index.js";

/**
 * A `.value` that reaches the server's markup.
 *
 * `.prop` bindings are client-only, which is right for most of them — there is no
 * markup for `textContent`. `value` is the exception, and it mattered once a slot
 * inside `<textarea>` was refused and `.value` became the thing to use instead: a
 * server-rendered form arrived with empty fields, and a submit before hydration
 * sent nothing.
 *
 * The spelling differs by element — an `<input>` carries it as an attribute, a
 * `<textarea>` as its content — and both are asserted through the browser's own
 * `.value`, which is the thing a form actually submits.
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

describe("aurora > browser > .value across SSR", () => {
	it("fills a textarea the browser can read, before any JavaScript binds", () => {
		container.innerHTML = renderToString(
			html`<textarea name="bio" .value="${"Hello & <goodbye>"}"></textarea>`,
		);
		const field = container.querySelector("textarea");
		if (field === null) throw new Error("expected the SSR textarea");
		// The browser's own value, decoded from the content — what a submit sends.
		expect(field.value).toBe("Hello & <goodbye>");
	});

	it("fills an input the same way", () => {
		container.innerHTML = renderToString(
			html`<input name="title" .value="${'a "b" c'}">`,
		);
		expect(container.querySelector("input")?.value).toBe('a "b" c');
	});

	it("is what a form submits before hydration", () => {
		// The defect stated as the user would meet it.
		container.innerHTML = renderToString(
			html`<form><input name="title" .value="${"Draft"}"><textarea name="bio" .value="${"Bio"}"></textarea></form>`,
		);
		const form = container.querySelector("form");
		if (form === null) throw new Error("expected the SSR form");
		const data = new FormData(form);
		expect(data.get("title")).toBe("Draft");
		expect(data.get("bio")).toBe("Bio");
	});

	it("hydrates without a mismatch, and stays bound afterwards", () => {
		const bio = signal("first");
		const factory = () => html`<textarea .value="${bio}"></textarea>`;
		container.innerHTML = renderToString(factory());
		expect(container.querySelector("textarea")?.value).toBe("first");
		hydrate(container, factory);
		expect(auroraWarnings()).toEqual([]);
		expect(container.querySelector("textarea")?.value).toBe("first");
		bio("second");
		expect(container.querySelector("textarea")?.value).toBe("second");
	});

	it("does not confuse a `>` in a later attribute for the end of the tag", () => {
		container.innerHTML = renderToString(
			html`<textarea .value="${"V"}" title="a > b"></textarea>`,
		);
		const field = container.querySelector("textarea");
		expect(field?.value).toBe("V");
		expect(field?.title).toBe("a > b");
	});

	it("leaves every other property to the client, and binds it on hydration", () => {
		// There is no markup for `textContent`, so the server writes nothing and
		// hydration is what applies it.
		const factory = () => html`<div .textContent="${"x"}"></div>`;
		const markup = renderToString(factory());
		expect(markup).toBe("<div></div>");
		container.innerHTML = markup;
		hydrate(container, factory);
		expect(auroraWarnings()).toEqual([]);
		expect(container.querySelector("div")?.textContent).toBe("x");
	});

	it("binds a property whose name has a capital in it", () => {
		// The parsed template lowercases attribute names, so `.textContent` used to
		// set an own property called `textcontent` — something was written, just
		// never the property asked for, and nothing warned. `.value` worked only
		// because it is already lowercase.
		const factory = () =>
			html`<div .textContent="${"x"}" .className="${"c"}"></div>`;
		container.innerHTML = renderToString(factory());
		hydrate(container, factory);
		const div = container.querySelector("div");
		if (div === null) throw new Error("expected the div");
		expect(div.textContent).toBe("x");
		expect(div.className).toBe("c");
		// And no stray lowercased property was invented alongside it.
		expect(Object.keys(div)).not.toContain("textcontent");
	});
});
