/**
 * An icon whose body is a template of its own, in a real browser.
 *
 * `svg(html\`<path/><path/>\`, props)` compiles the body with no parent, and
 * the HTML parser has no self-closing tag for an unknown element: the second
 * `<path>` became a CHILD of the first, in the XHTML namespace. Nothing threw
 * and nothing reached the console — the icon was just invisible.
 *
 * This belongs in the Chromium layer rather than beside the jsdom tests: the
 * bug IS the parser's foreign-content handling, and a lenient DOM
 * implementation is the wrong witness for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, hydrate, renderToString } from "../../src/index.js";
import { render } from "../../src/render.js";

const SVG_NS = "http://www.w3.org/2000/svg";

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

const warnings = () =>
	warnSpy.mock.calls
		.map((c: unknown[]) => String(c[0]))
		.filter((m: string) => m.includes("[aurora]"));

/** The helper shape an icon set is written with. */
const icon = (children: unknown) =>
	html`<svg viewBox="0 0 24 24" width="24" height="24">${children}</svg>`;
const body = () => html`<path d="M19 7V4" /><path d="M3 5v14" />`;

describe("aurora > an icon composed from a separate template", () => {
	it("paints two sibling paths, not one inside the other", () => {
		render(icon(body()), container);

		const paths = container.querySelectorAll("path");
		expect(paths).toHaveLength(2);
		expect(paths[0]?.contains(paths[1] as Node)).toBe(false);
		expect(paths[0]?.namespaceURI).toBe(SVG_NS);
	});

	it("does the same inside a reactive fragment", () => {
		// Where it was found: an empty-state panel that renders its icon
		// through `${() => …}`.
		render(html`<div>${() => icon(body())}</div>`, container);

		const paths = container.querySelectorAll("path");
		expect(paths).toHaveLength(2);
		expect(paths[0]?.contains(paths[1] as Node)).toBe(false);
	});

	it("hydrates the server's markup without a mismatch", () => {
		// The two halves have to agree: the server had the `<svg>` ancestor in
		// scope and got it right, so a client that nests instead diverges.
		container.innerHTML = renderToString(icon(body()));
		hydrate(container, () => icon(body()));

		expect(warnings()).toEqual([]);
		expect(container.querySelectorAll("path")).toHaveLength(2);
	});
});
