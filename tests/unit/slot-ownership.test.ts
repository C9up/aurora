/**
 * A slot keeps track of what it shows, and only that.
 *
 * Every value a slot rendered was also pushed onto the root's list of nodes,
 * which only the root's disposer ever emptied: an app that changed page kept
 * every page it had shown, with their listeners and their `<video>` elements.
 * And a slot only knew the nodes of its own render, so the content of a slot
 * nested at its head, swapped since, stayed on screen when the outer slot
 * changed.
 */

import { describe, expect, it } from "vitest";
import {
	each,
	html,
	hydrate,
	render,
	renderToString,
	signal,
} from "../../src/index.js";

/** The `gc()` that `--expose-gc` installs (see vitest.config.ts). */
function collectGarbage(): void {
	const gc: unknown = Reflect.get(globalThis, "gc");
	if (typeof gc !== "function") throw new Error("run with --expose-gc");
	gc();
}

/**
 * Whether nothing holds `ref`'s target any more, once the pending work has run.
 * The element is never taken with `querySelector`: jsdom caches what a selector
 * found, and the cache would hold it.
 */
async function isCollected(ref: WeakRef<object>): Promise<boolean> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	for (let i = 0; i < 3; i++) collectGarbage();
	return ref.deref() === undefined;
}

/** The first element named `tag` under `root`, by walking its children. */
function first(root: Node, tag: string): WeakRef<object> {
	const walk = (node: Node): Element | undefined => {
		for (const child of node.childNodes) {
			if (child instanceof Element && child.localName === tag) return child;
			const found = walk(child);
			if (found) return found;
		}
		return undefined;
	};
	const found = walk(root);
	if (found === undefined) throw new Error(`no <${tag}>`);
	return new WeakRef(found);
}

describe("nothing keeps a replaced page in memory", () => {
	it("lets a page a slot replaced be collected", async () => {
		const shown = signal(0);
		const host = document.createElement("div");
		const dispose = render(
			html`<main>${() => html`<section><p>page ${shown()}</p></section>`}</main>`,
			host,
		);
		const page = first(host, "section");
		for (let i = 1; i < 50; i++) shown(i);
		expect(await isCollected(page)).toBe(true);
		dispose();
	});

	it("nor one a slot at the head of the root replaced", async () => {
		const shown = signal(0);
		const host = document.createElement("div");
		const dispose = render(
			html`${() => html`<section>${shown()}</section>`}`,
			host,
		);
		const page = first(host, "section");
		shown(1);
		expect(await isCollected(page)).toBe(true);
		dispose();
	});

	it("nor the first page of a slot nested in another one", async () => {
		const inner = signal(0);
		const host = document.createElement("div");
		const dispose = render(
			html`<main>${() => html`${() => html`<section>${inner()}</section>`}`}</main>`,
			host,
		);
		const page = first(host, "section");
		inner(1);
		expect(await isCollected(page)).toBe(true);
		dispose();
	});

	it("nor what a kept row's head slot replaced", async () => {
		const rows = signal([{ id: 1, label: "a" }]);
		const host = document.createElement("div");
		const dispose = render(
			html`<ul>${each(
				rows,
				(row) => row.id,
				(row) => html`${() => html`<li>${row().label}</li>`}`,
			)}</ul>`,
			host,
		);
		const item = first(host, "li");
		rows([{ id: 1, label: "b" }]);
		expect(await isCollected(item)).toBe(true);
		dispose();
	});

	it("nor the server's page once a hydrated slot replaced it", async () => {
		const shown = signal(0);
		const view = () =>
			html`<main>${() => html`<section>page ${shown()}</section>`}</main>`;
		const host = document.createElement("div");
		host.innerHTML = renderToString(view());
		const dispose = hydrate(host, view);
		const page = first(host, "section");
		shown(1);
		expect(await isCollected(page)).toBe(true);
		dispose();
	});

	it("nor a server row the list removed", async () => {
		const rows = signal([{ id: 1 }, { id: 2 }]);
		const view = () =>
			html`<ul>${each(
				rows,
				(row) => row.id,
				(row) => html`<li>${() => row().id}</li>`,
			)}</ul>`;
		const host = document.createElement("div");
		host.innerHTML = renderToString(view());
		const dispose = hydrate(host, view);
		const removed = first(host, "li");
		rows([{ id: 2 }]);
		expect(await isCollected(removed)).toBe(true);
		dispose();
	});

	it("nor a server row that an accessor's list removed", async () => {
		const rows = signal([{ id: 1 }, { id: 2 }]);
		const view = () =>
			html`<ul>${() =>
				each(
					rows,
					(row) => row.id,
					(row) => html`<li>${() => row().id}</li>`,
				)}</ul>`;
		const host = document.createElement("div");
		host.innerHTML = renderToString(view());
		const dispose = hydrate(host, view);
		const removed = first(host, "li");
		rows([{ id: 2 }]);
		expect(await isCollected(removed)).toBe(true);
		dispose();
	});
});

describe("a slot owns what it shows", () => {
	it("removes what a slot at the head of its content swapped in", () => {
		const outer = signal("a");
		const inner = signal(1);
		const host = document.createElement("div");
		render(
			html`<main>${() =>
				outer() === "a"
					? html`${() => html`<p>inner ${inner()}</p>`}`
					: html`<p>other</p>`}</main>`,
			host,
		);
		inner(2);
		outer("b");
		expect(host.textContent).toBe("other");
	});

	it("removes it when the root is disposed", () => {
		const page = signal(1);
		const host = document.createElement("div");
		const dispose = render(html`${() => html`<p>page ${page()}</p>`}`, host);
		page(2);
		dispose();
		expect(host.childNodes.length).toBe(0);
	});

	it("clears its whole range after hydration, a nested slot's later nodes too", () => {
		const outer = signal("a");
		const inner = signal(1);
		const view = () =>
			html`<main>${() =>
				outer() === "a"
					? html`${() => html`<p>inner ${inner()}</p>`}`
					: html`<p>other</p>`}</main>`;
		const host = document.createElement("div");
		host.innerHTML = renderToString(view());
		hydrate(host, view);
		inner(2);
		expect(host.textContent).toBe("inner 2");
		outer("b");
		expect(host.textContent).toBe("other");
	});

	it("removes a list's rows with the slot that held it", () => {
		const rows = signal([{ id: 1 }]);
		const shown = signal(true);
		const host = document.createElement("div");
		render(
			html`<ul>${() =>
				shown()
					? html`${each(
							rows,
							(row) => row.id,
							(row) => html`<li>${() => row().id}</li>`,
						)}`
					: html`<li>none</li>`}</ul>`,
			host,
		);
		rows([{ id: 1 }, { id: 2 }]);
		shown(false);
		// Count the items: a row left behind is an empty <li>, its text removed
		// by its own slot.
		expect(
			Array.from(host.getElementsByTagName("li"), (li) => li.textContent),
		).toEqual(["none"]);
	});
});
