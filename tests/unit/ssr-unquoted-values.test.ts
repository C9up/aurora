import { describe, expect, it } from "vitest";
import { html } from "../../src/html.js";
import { hydrate } from "../../src/hydrate.js";
import { signal } from "../../src/reactive.js";
import { render } from "../../src/render.js";
import { renderToString } from "../../src/ssr.js";
import type { TemplateResult } from "../../src/types.js";

/**
 * An unquoted attribute value cannot be empty: the tokenizer skips whitespace
 * after an `=`, so `title= data-note="…"` gives `title` the text that follows.
 * The server writes every unquoted value that holds a slot between quotes, so
 * an empty value is `title=""` and the next attribute stays whole.
 */

// What a visitor stored in a text field: no quote, no angle bracket.
const STORED = "x onmouseover=alert(document.domain) y";

function attributesOf(
	markup: string,
	selector: string,
): Record<string, string> {
	const host = document.createElement("div");
	host.innerHTML = markup;
	const element = host.querySelector(selector);
	return Object.fromEntries(
		Array.from(element?.attributes ?? []).map((a) => [a.name, a.value]),
	);
}

function clientAttributes(
	result: TemplateResult,
	selector: string,
): Record<string, string> {
	const host = document.createElement("div");
	render(result, host);
	return attributesOf(host.innerHTML, selector);
}

const EMPTY: ReadonlyArray<readonly [string, unknown]> = [
	["''", ""],
	["[]", []],
	["true", true],
	["signal('')", signal("")],
	["() => ''", () => ""],
];

describe("ssr > an unquoted attribute value holding a slot", () => {
	it("is written quoted, so an empty value keeps the next attribute whole", () => {
		for (const [label, empty] of EMPTY) {
			const make = (): TemplateResult =>
				html`<div title=${empty} data-note="${STORED}">t</div>`;
			const out = renderToString(make());
			const server = attributesOf(out, "div");
			expect(server, label).toEqual(clientAttributes(make(), "div"));
			expect(server["data-note"], label).toBe(STORED);
			expect(server.onmouseover, label).toBeUndefined();
		}
		expect(
			renderToString(html`<div title=${""} data-note="${STORED}">t</div>`),
		).toBe(`<div title="" data-note="${STORED}">t</div>`);
	});

	it("keeps a static attribute, `>` and `/>` after it", () => {
		for (const [label, empty] of EMPTY) {
			const link = attributesOf(
				renderToString(
					html`<a href=${empty} rel="noopener noreferrer" target="_blank">t</a>`,
				),
				"a",
			);
			expect(link.rel, label).toBe("noopener noreferrer");
			expect(link.target, label).toBe("_blank");
			const frame = attributesOf(
				renderToString(html`<iframe src=${empty} sandbox></iframe>`),
				"iframe",
			);
			expect(Object.keys(frame), label).toEqual(["src", "sandbox"]);
			const input = attributesOf(
				renderToString(html`<input value=${empty}>`),
				"input",
			);
			expect(Object.keys(input), label).toEqual(["value"]);
			const closed = attributesOf(
				renderToString(html`<input value=${empty} />`),
				"input",
			);
			expect(Object.keys(closed), label).toEqual(["value"]);
		}
	});

	it("does not let a stored placeholder focus and run a handler", () => {
		const field = (value: string, hint: string): TemplateResult =>
			html`<input name="nickname" value=${value} placeholder="${hint}">`;
		const input = attributesOf(
			renderToString(field("", "x autofocus onfocus=alert(document.domain) y")),
			"input",
		);
		expect(input).toEqual({
			name: "nickname",
			value: "",
			placeholder: "x autofocus onfocus=alert(document.domain) y",
		});
	});

	it("leaves nothing behind for hydration to keep", () => {
		const title = signal("");
		const view = (): TemplateResult =>
			html`<div title=${title} data-note="${STORED}">t</div>`;
		const host = document.createElement("div");
		host.innerHTML = renderToString(view());
		hydrate(host, view);
		title("set after hydration");
		expect(attributesOf(host.innerHTML, "div")).toEqual({
			title: "set after hydration",
			"data-note": STORED,
		});
	});

	it("quotes a value made of several slots, or of static text and slots", () => {
		const both = attributesOf(
			renderToString(html`<div title=${""}${""} data-note="${STORED}">t</div>`),
			"div",
		);
		expect(both).toEqual({ title: "", "data-note": STORED });
		const path = renderToString(html`<img src=/img/${"a b.png"} alt="k">`);
		expect(path).toBe('<img src="/img/a b.png" alt="k">');
		// A quote the author left in an unquoted value stays a character of it.
		const quoted = html`<div data-x=a"b${"c"} title="t">x</div>`;
		expect(attributesOf(renderToString(quoted), "div")).toEqual(
			clientAttributes(quoted, "div"),
		);
		expect(attributesOf(renderToString(quoted), "div")["data-x"]).toBe('a"bc');
	});

	it("still drops the attribute for null, undefined and false", () => {
		for (const absent of [null, undefined, false]) {
			expect(
				renderToString(
					html`<div title=${absent} data-note="${STORED}">t</div>`,
				),
			).toBe(`<div data-note="${STORED}">t</div>`);
		}
	});

	it("leaves static unquoted values as written", () => {
		expect(renderToString(html`<img src=/a.png alt=${"k"}>`)).toBe(
			'<img src=/a.png alt="k">',
		);
	});
});
