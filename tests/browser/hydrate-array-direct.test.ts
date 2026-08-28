import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, hydrate, renderToString } from "../../src/index.js";

/**
 * A DIRECT (non-reactive) array slot whose items carry an ATTRIBUTE binding.
 *
 * Reported from a consumer app and reduced to one variable: the number of
 * items. One item hydrates clean; two produce "slot path not found" for the
 * attribute inside each item. The reactive-array case is covered next door
 * (hydrate-array.test.ts) and passes, so the two paths are not the same.
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

const ROWS = [
	{ href: "/a", label: "Alpha" },
	{ href: "/b", label: "Bravo" },
];

// Formatted across lines — a prettier-shaped item template. That puts a
// whitespace TEXT node on each side of the <li> inside the template content.
const row = (r: { href: string; label: string }) =>
	html`
		<li><a href="${r.href}">${r.label}</a></li>
	`;

describe("aurora > browser > direct array slot with an attribute binding", () => {
	for (const count of [1, 2, 3]) {
		it(`hydrates ${count} item(s) without a slot-path warning`, () => {
			const rows = [...ROWS, { href: "/c", label: "Charlie" }].slice(0, count);
			const factory = () => html`<ul>${rows.map(row)}</ul>`;

			container.innerHTML = renderToString(factory());
			expect(container.querySelectorAll("li").length).toBe(count);

			hydrate(container, factory);

			expect(auroraWarnings()).toEqual([]);
			// Every href must have survived: an attribute cannot legitimately
			// differ between server and client, so a mismatch here is the bug.
			const hrefs = [...container.querySelectorAll("a")].map((a) =>
				a.getAttribute("href"),
			);
			expect(hrefs).toEqual(rows.map((r) => r.href));
		});
	}
});

describe("aurora > browser > text-node merging at item boundaries", () => {
	it("hydrates adjacent SCALAR items, which merge into one live text node", () => {
		// Two bare scalars render as "AlphaBravo" — ONE text node once the
		// browser has parsed it. The array hydrator used to count one node per
		// item and shift everything after the first.
		const tail = { label: "tail" };
		const factory = () =>
			html`<p>${["Alpha", "Bravo", "Charlie"]}</p><span>${tail.label}</span>`;

		container.innerHTML = renderToString(factory());
		hydrate(container, factory);

		expect(auroraWarnings()).toEqual([]);
		expect(container.querySelector("p")?.textContent).toBe("AlphaBravoCharlie");
		expect(container.querySelector("span")?.textContent).toBe("tail");
	});

	it("keeps a slot AFTER the list aligned when the items are whitespace-formatted", () => {
		// The desync was not confined to the list: every slot that follows
		// resolves against a shifted node list too.
		const factory = () =>
			html`<div><ul>${ROWS.map(row)}</ul><p class="tail">${"after"}</p></div>`;

		container.innerHTML = renderToString(factory());
		hydrate(container, factory);

		expect(auroraWarnings()).toEqual([]);
		expect(container.querySelector("p.tail")?.textContent).toBe("after");
		expect(
			[...container.querySelectorAll("a")].map((a) => a.getAttribute("href")),
		).toEqual(["/a", "/b"]);
	});

	it("hydrates a compact item template, which has no boundary text at all", () => {
		const compact = (r: { href: string; label: string }) =>
			html`<li><a href="${r.href}">${r.label}</a></li>`;
		const factory = () => html`<ul>${ROWS.map(compact)}</ul>`;

		container.innerHTML = renderToString(factory());
		hydrate(container, factory);

		expect(auroraWarnings()).toEqual([]);
		expect(
			[...container.querySelectorAll("a")].map((a) => a.getAttribute("href")),
		).toEqual(["/a", "/b"]);
	});
});
