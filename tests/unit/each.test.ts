/**
 * A list keeps its rows by key.
 *
 * A reactive slot that returned an array tore down and rebuilt every row on
 * each new array, even one holding the same elements: a list re-read every few
 * seconds lost its open menus, its focus and its hover each time. `each` keeps
 * a row per key — same nodes, same effects — moves it when the order changes,
 * and hands it the new element through its accessor.
 */

import { describe, expect, it } from "vitest";
import {
	AuroraError,
	component,
	createContext,
	each,
	html,
	hydrate,
	inject,
	memo,
	onMount,
	onUnmount,
	provide,
	render,
	renderToString,
	signal,
} from "../../src/index.js";

interface Row {
	id: number;
	name: string;
}

function list(rows: () => readonly Row[]) {
	return html`<ul>${each(
		rows,
		(row) => row.id,
		(row) => html`<li data-id="${() => row().id}">${() => row().name}</li>`,
	)}</ul>`;
}

const items = (host: Element): HTMLLIElement[] =>
	Array.from(host.querySelectorAll("li"));

/** The same nodes, by identity — `toEqual` would accept a rebuilt copy. */
function expectSameNodes(actual: Node[], expected: Array<Node | undefined>) {
	expect(actual.length).toBe(expected.length);
	for (const [i, node] of actual.entries()) expect(node).toBe(expected[i]);
}

describe("each > keeps rows by key", () => {
	it("leaves the rows alone when a new array holds the same keys", () => {
		const rows = signal<readonly Row[]>([
			{ id: 1, name: "a" },
			{ id: 2, name: "b" },
		]);
		const host = document.createElement("div");
		render(list(rows), host);
		const before = items(host);

		const added: Node[] = [];
		const removed: Node[] = [];
		const observer = new MutationObserver((records) => {
			for (const r of records) {
				added.push(...r.addedNodes);
				removed.push(...r.removedNodes);
			}
		});
		observer.observe(host, { childList: true, subtree: true });
		rows([...rows()]);
		rows([
			{ id: 1, name: "a" },
			{ id: 2, name: "B" },
		]);
		const records = observer.takeRecords();
		observer.disconnect();
		for (const r of records) {
			added.push(...r.addedNodes);
			removed.push(...r.removedNodes);
		}

		expectSameNodes(items(host), before);
		expect(host.textContent).toBe("aB");
		// Only the changed name's text was written: no row came or went.
		expect([...added, ...removed].some((n) => n.nodeName === "LI")).toBe(false);
	});

	it("moves a row whose position changed, keeping its node", () => {
		const rows = signal<readonly Row[]>([
			{ id: 1, name: "a" },
			{ id: 2, name: "b" },
			{ id: 3, name: "c" },
		]);
		const host = document.createElement("div");
		render(list(rows), host);
		const [a, b, c] = items(host);

		rows([
			{ id: 3, name: "c" },
			{ id: 1, name: "a" },
			{ id: 2, name: "b" },
		]);
		expectSameNodes(items(host), [c, a, b]);
		expect(host.textContent).toBe("cab");
	});

	it("disposes a row whose key left, and builds one for a new key", () => {
		const unmounted: number[] = [];
		const Item = component((props: { row: () => Row }) => {
			onUnmount(() => unmounted.push(props.row().id));
			return html`<li>${() => props.row().name}</li>`;
		});
		const rows = signal<readonly Row[]>([
			{ id: 1, name: "a" },
			{ id: 2, name: "b" },
		]);
		const host = document.createElement("div");
		render(
			html`<ul>${each(
				rows,
				(row) => row.id,
				(row) => Item({ row }),
			)}</ul>`,
			host,
		);
		const [, b] = items(host);

		rows([
			{ id: 2, name: "b" },
			{ id: 4, name: "d" },
		]);
		expect(unmounted).toEqual([1]);
		expect(items(host)[0]).toBe(b);
		expect(host.textContent).toBe("bd");
	});

	it("gives a row its current index", () => {
		const rows = signal<readonly Row[]>([
			{ id: 1, name: "a" },
			{ id: 2, name: "b" },
		]);
		const host = document.createElement("div");
		render(
			html`<ol>${each(
				rows,
				(row) => row.id,
				(row, index) => html`<li>${() => `${index()}:${row().name}`}</li>`,
			)}</ol>`,
			host,
		);
		rows([
			{ id: 2, name: "b" },
			{ id: 1, name: "a" },
		]);
		expect(host.textContent).toBe("0:b1:a");
	});

	it("refuses two elements with one key", () => {
		const host = document.createElement("div");
		const rows: readonly Row[] = [
			{ id: 1, name: "a" },
			{ id: 1, name: "b" },
		];
		expect(() =>
			render(
				list(() => rows),
				host,
			),
		).toThrowError(AuroraError);
		expect(() =>
			render(
				list(() => rows),
				host,
			),
		).toThrowError(/share the key 1/);
	});

	it("runs the onMount of a row added after the first render", () => {
		const mounted: string[] = [];
		const Item = component((props: { name: string }) => {
			onMount(() => {
				mounted.push(props.name);
			});
			return html`<li>${props.name}</li>`;
		});
		const rows = signal<readonly Row[]>([{ id: 1, name: "a" }]);
		const host = document.createElement("div");
		document.body.append(host);
		render(
			html`<ul>${each(
				rows,
				(row) => row.id,
				(row) => Item({ name: row().name }),
			)}</ul>`,
			host,
		);
		rows([...rows(), { id: 2, name: "b" }]);
		expect(mounted).toEqual(["a", "b"]);
		host.remove();
	});

	it("builds a row added later in the context the list was written in", () => {
		const Theme = createContext<string>("Theme");
		const Item = component(
			(props: { name: string }) =>
				html`<li>${inject(Theme)}:${props.name}</li>`,
		);
		const rows = signal<readonly Row[]>([{ id: 1, name: "a" }]);
		const Root = component(() => {
			provide(Theme, "dark");
			return html`<ul>${each(
				rows,
				(row) => row.id,
				(row) => Item({ name: row().name }),
			)}</ul>`;
		});
		const host = document.createElement("div");
		render(Root(), host);
		rows([...rows(), { id: 2, name: "b" }]);
		expect(host.textContent).toBe("dark:adark:b");
	});
});

describe("each > a row's nodes include what it added later", () => {
	interface Group {
		id: string;
		children: readonly string[];
	}

	const nested = (groups: () => readonly Group[]) =>
		html`<ul>${each(
			groups,
			(group) => group.id,
			(group) =>
				html`${each(
					() => group().children,
					(child) => child,
					(child) => html`<li>${child}</li>`,
				)}`,
		)}</ul>`;

	const labels = (host: Element) => items(host).map((li) => li.textContent);

	it("moves the children a nested list added since the row was built", () => {
		const groups = signal<readonly Group[]>([
			{ id: "a", children: ["a1"] },
			{ id: "b", children: ["b1"] },
		]);
		const host = document.createElement("div");
		render(nested(groups), host);
		groups([
			{ id: "a", children: ["a1", "a2"] },
			{ id: "b", children: ["b1"] },
		]);
		groups([
			{ id: "b", children: ["b1"] },
			{ id: "a", children: ["a1", "a2"] },
		]);
		expect(labels(host)).toEqual(["b1", "a1", "a2"]);
	});

	it("removes them with the row", () => {
		const groups = signal<readonly Group[]>([
			{ id: "a", children: ["a1"] },
			{ id: "b", children: ["b1"] },
		]);
		const host = document.createElement("div");
		render(nested(groups), host);
		groups([
			{ id: "a", children: ["a1", "a2"] },
			{ id: "b", children: ["b1"] },
		]);
		groups([{ id: "b", children: ["b1"] }]);
		expect(labels(host)).toEqual(["b1"]);
	});

	it("moves them in a hydrated list too", () => {
		const groups = signal<readonly Group[]>([
			{ id: "a", children: ["a1"] },
			{ id: "b", children: ["b1"] },
		]);
		const host = document.createElement("div");
		host.innerHTML = renderToString(nested(groups));
		hydrate(host, () => nested(groups));
		groups([
			{ id: "a", children: ["a1", "a2"] },
			{ id: "b", children: ["b1"] },
		]);
		groups([
			{ id: "b", children: ["b1"] },
			{ id: "a", children: ["a1", "a2"] },
		]);
		expect(labels(host)).toEqual(["b1", "a1", "a2"]);
	});
});

describe("each > returned by an accessor", () => {
	const page = (rows: () => readonly Row[]) => {
		// A memo, so the accessor only re-runs when emptiness flips: reading the
		// rows in it would make a new list on every change.
		const empty = memo(() => rows().length === 0);
		return html`<ul>${() =>
			empty()
				? html`<li>none</li>`
				: each(
						rows,
						(row) => row.id,
						(row) => html`<li>${() => row().name}</li>`,
					)}</ul>`;
	};

	it("keeps its rows while the accessor returns the same list", () => {
		const rows = signal<readonly Row[]>([{ id: 1, name: "a" }]);
		const host = document.createElement("div");
		render(page(rows), host);
		const [a] = items(host);
		rows([{ id: 0, name: "z" }, ...rows()]);
		expect(host.textContent).toBe("za");
		expect(items(host)[1]).toBe(a);
	});

	it("removes every row, the later ones too, when the accessor swaps it out", () => {
		const rows = signal<readonly Row[]>([{ id: 1, name: "a" }]);
		const host = document.createElement("div");
		render(page(rows), host);
		rows([...rows(), { id: 2, name: "b" }]);
		rows([]);
		expect(host.textContent).toBe("none");
		rows([{ id: 3, name: "c" }]);
		expect(host.textContent).toBe("c");
	});

	it("adopts the server's rows, then keeps them by key", () => {
		const rows = signal<readonly Row[]>([
			{ id: 1, name: "a" },
			{ id: 2, name: "b" },
		]);
		const host = document.createElement("div");
		host.innerHTML = renderToString(page(rows));
		const [a, b] = items(host);
		hydrate(host, () => page(rows));
		rows([
			{ id: 2, name: "b" },
			{ id: 1, name: "A" },
		]);
		expectSameNodes(items(host), [b, a]);
		expect(host.textContent).toBe("bA");
		rows([]);
		expect(host.textContent).toBe("none");
	});
});

describe("each > on the server and through hydration", () => {
	it("renders as the array of its rows", () => {
		const host = document.createElement("div");
		host.innerHTML = renderToString(
			list(() => [
				{ id: 1, name: "a" },
				{ id: 2, name: "b" },
			]),
		);
		expect(host.textContent).toBe("ab");
		expect(items(host).map((li) => li.dataset.id)).toEqual(["1", "2"]);
	});

	it("adopts the server's rows, then keeps them by key", () => {
		const rows = signal<readonly Row[]>([
			{ id: 1, name: "a" },
			{ id: 2, name: "b" },
		]);
		const host = document.createElement("div");
		host.innerHTML = renderToString(list(rows));
		const [a, b] = items(host);
		hydrate(host, () => list(rows));
		expectSameNodes(items(host), [a, b]);

		rows([
			{ id: 2, name: "B" },
			{ id: 1, name: "a" },
			{ id: 3, name: "c" },
		]);
		const after = items(host);
		expect(after[0]).toBe(b);
		expect(after[1]).toBe(a);
		expect(host.textContent).toBe("Bac");
	});

	it("keeps the slots after the list wired", () => {
		const rows = signal<readonly Row[]>([
			{ id: 1, name: "a" },
			{ id: 2, name: "b" },
		]);
		const title = signal("before");
		const page = () => html`<div>${list(rows)}<p>${() => title()}</p></div>`;
		const host = document.createElement("div");
		host.innerHTML = renderToString(page());
		hydrate(host, page);
		title("after");
		expect(host.querySelector("p")?.textContent).toBe("after");
		rows([{ id: 2, name: "b" }]);
		expect(host.textContent).toBe("bafter");
	});

	it("moves a server row whose template is surrounded by text", () => {
		// Formatted templates start and end with whitespace, which the browser
		// merges across rows into one node.
		const rows = signal<readonly Row[]>([
			{ id: 1, name: "a" },
			{ id: 2, name: "b" },
			{ id: 3, name: "c" },
		]);
		const page = () =>
			html`<ul>${each(
				rows,
				(row) => row.id,
				(row) => html`
					<li>${() => row().name}</li>
				`,
			)}</ul>`;
		const host = document.createElement("div");
		host.innerHTML = renderToString(page());
		const [a, b, c] = items(host);
		hydrate(host, page);
		rows([
			{ id: 3, name: "c" },
			{ id: 2, name: "b" },
			{ id: 1, name: "a" },
		]);
		expectSameNodes(items(host), [c, b, a]);
		expect(host.textContent?.replace(/\s+/g, "")).toBe("cba");
	});
});
