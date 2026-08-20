import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { html, hydrate, renderToString, signal } from "../../src/index.js";

let container: HTMLElement;
beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});
afterEach(() => container.remove());

describe("aurora > fragments", () => {
	it("a multi-root template is already a fragment — no wrapper element", () => {
		const Cells = () => html`<td>A</td><td>B</td>`;
		const Row = () => html`<table><tbody><tr>${Cells()}</tr></tbody></table>`;

		container.innerHTML = renderToString(Row());
		hydrate(container, Row);

		const tr = container.querySelector("tr");
		expect(tr?.children.length).toBe(2);
		expect(Array.from(tr?.children ?? []).map((c) => c.tagName)).toEqual([
			"TD",
			"TD",
		]);
	});

	it("a conditional branch can return several roots", () => {
		const expanded = signal(false);
		const View = () =>
			html`<dl>
				<dt>Nom</dt>
				${() => (expanded() ? html`<dd>Alice</dd><dd>Paris</dd>` : html`<dd>—</dd>`)}
			</dl>`;

		container.innerHTML = renderToString(View());
		hydrate(container, View);
		expect(container.querySelectorAll("dd").length).toBe(1);

		expanded(true);
		expect(container.querySelectorAll("dd").length).toBe(2);
		expect(container.querySelector("dl")?.querySelector("div")).toBeNull();
	});

	it("a list item can be several siblings without a wrapper", () => {
		const items = signal<string[]>([]);
		const View = () =>
			html`<dl>${() => items().map((i) => html`<dt>${i}</dt><dd>valeur</dd>`)}</dl>`;

		container.innerHTML = renderToString(View());
		hydrate(container, View);
		items(["a", "b"]);

		expect(container.querySelectorAll("dt").length).toBe(2);
		expect(container.querySelectorAll("dd").length).toBe(2);
	});
});
