import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	component,
	html,
	hydrate,
	renderToString,
	signal,
} from "../../src/index.js";

/**
 * SVG bodies written as their OWN template, carrying slots, rendered once per
 * item of a mapped array — the chart-list shape.
 *
 * Two failures hide here, and only one of them warns. A body compiled with no
 * `<svg>` in scope is parsed as HTML, where nothing self-closes: siblings become
 * ancestors, in the XHTML namespace. When the body ends in an element the HTML
 * parser DOES understand (`<text>`), the shapes disagree enough that slot paths
 * miss and hydration says so — and the count grows with the list, which is why
 * a single chart looked fine and a dashboard did not. When it ends in one the
 * parser doesn't (`<path>`, `<circle>`), the paths still resolve and nothing is
 * reported: the elements are simply in a namespace that paints nothing.
 *
 * A list is the case worth pinning because per-item repetition is what turns a
 * quiet mis-parse into a visibly broken page.
 */

let container: HTMLElement;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

function auroraWarnings(): string[] {
	return warnSpy.mock.calls
		.map((c: unknown[]) => String(c[0]))
		.filter((m: string) => m.includes("[aurora]"));
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The body of one bar chart, as its own template — slots inside SVG. */
const chartBody = (value: number, label: string) =>
	html`<path d="${`M0 ${40 - value} L100 ${40 - value}`}"/><text x="0" y="38">${label}</text>`;

const Chart = component(
	(d: { label: string; value: number }) =>
		html`<figure class="chart"><svg viewBox="0 0 100 40">${chartBody(d.value, d.label)}</svg><figcaption>${d.label}</figcaption></figure>`,
);

describe("aurora > browser > SVG sub-template inside a mapped array", () => {
	for (const count of [1, 2, 3]) {
		it(`hydrates ${count} chart(s) with no path mismatch`, () => {
			const rows = signal(
				Array.from({ length: count }, (_, i) => ({
					label: `c${i}`,
					value: 10 + i,
				})),
			);
			const factory = () =>
				html`<div class="board">${() => rows().map((r) => Chart(r))}</div>`;

			container.innerHTML = renderToString(factory());
			hydrate(container, factory);

			expect(auroraWarnings()).toEqual([]);
			// One <path> and one <text> per chart, as SIBLINGS — not nested, which
			// is what an HTML-context parse produces.
			const paths = container.querySelectorAll("path");
			expect(paths.length).toBe(count);
			for (const path of paths) {
				expect(path.namespaceURI).toBe(SVG_NS);
				expect(path.parentElement?.tagName).toBe("svg");
			}
			expect(container.querySelectorAll("text").length).toBe(count);
			// Every slot landed: the label reaches both the SVG and the caption.
			expect(
				[...container.querySelectorAll("text")].map((t) => t.textContent),
			).toEqual(rows().map((r) => r.label));
			expect(
				[...container.querySelectorAll("figcaption")].map((f) => f.textContent),
			).toEqual(rows().map((r) => r.label));
		});
	}

	it("keeps the list reactive after hydration", () => {
		const rows = signal([
			{ label: "a", value: 10 },
			{ label: "b", value: 11 },
		]);
		const factory = () =>
			html`<div class="board">${() => rows().map((r) => Chart(r))}</div>`;

		container.innerHTML = renderToString(factory());
		hydrate(container, factory);

		rows([...rows(), { label: "c", value: 12 }]);
		expect(container.querySelectorAll("path").length).toBe(3);
		for (const path of container.querySelectorAll("path")) {
			// A chart added AFTER hydration goes through the client path, which
			// must agree with the server about the namespace.
			expect(path.namespaceURI).toBe(SVG_NS);
		}
		expect(auroraWarnings()).toEqual([]);
	});
});
