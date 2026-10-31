import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	each,
	html,
	hydrate,
	renderToString,
	signal,
} from "../../src/index.js";

/**
 * A keyed list adopts the rows Chromium parsed from the server's markup, then
 * keeps them by key: a re-read that returns the same rows leaves every node in
 * place, and a reorder moves them. The rows are formatted templates, so the
 * browser merges the whitespace between two rows into one text node — the
 * boundary the row slicing has to get right.
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

describe("aurora > browser > each() through hydration", () => {
	it("keeps the server's rows by key, and moves them", () => {
		const rows = signal([
			{ id: 1, name: "Alice" },
			{ id: 2, name: "Bob" },
			{ id: 3, name: "Carol" },
		]);
		const clicks: number[] = [];
		const tail = signal("hello");
		const factory = () => html`<div>
			<ul>${each(
				rows,
				(row) => row.id,
				(row) => html`
					<li @click=${() => clicks.push(row().id)}>${() => row().name}</li>
				`,
			)}</ul>
			<p>${tail}</p>
		</div>`;

		container.innerHTML = renderToString(factory());
		const [alice, bob, carol] = Array.from(container.querySelectorAll("li"));
		hydrate(container, factory);
		expect(
			warnSpy.mock.calls.filter((c: unknown[]) =>
				String(c[0]).includes("[aurora]"),
			),
		).toEqual([]);

		rows([...rows()].map((row) => ({ ...row })));
		let lis = Array.from(container.querySelectorAll("li"));
		expect(lis[0]).toBe(alice);
		expect(lis[1]).toBe(bob);
		expect(lis[2]).toBe(carol);

		rows([
			{ id: 3, name: "Carol" },
			{ id: 1, name: "Alicia" },
			{ id: 2, name: "Bob" },
		]);
		lis = Array.from(container.querySelectorAll("li"));
		expect(lis[0]).toBe(carol);
		expect(lis[1]).toBe(alice);
		expect(lis[2]).toBe(bob);
		expect(alice?.textContent).toBe("Alicia");

		alice?.click();
		expect(clicks).toEqual([1]);
		tail("changed");
		expect(container.querySelector("p")?.textContent).toBe("changed");
	});

	it("moves a server row with the children its nested list added since", () => {
		const groups = signal([
			{ id: "a", children: ["a1"] },
			{ id: "b", children: ["b1"] },
		]);
		const factory = () =>
			html`<ul>${each(
				groups,
				(group) => group.id,
				(group) => html`
				${each(
					() => group().children,
					(child) => child,
					(child) => html`
						<li>${child}</li>
					`,
				)}
			`,
			)}</ul>`;

		container.innerHTML = renderToString(factory());
		hydrate(container, factory);
		groups([
			{ id: "a", children: ["a1", "a2"] },
			{ id: "b", children: ["b1"] },
		]);
		groups([
			{ id: "b", children: ["b1"] },
			{ id: "a", children: ["a1", "a2"] },
		]);
		expect(
			Array.from(container.querySelectorAll("li"), (li) => li.textContent),
		).toEqual(["b1", "a1", "a2"]);
	});
});
