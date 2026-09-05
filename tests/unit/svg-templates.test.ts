/**
 * SVG content compiled as a template of its own.
 *
 * An icon helper writes `svg(html\`<path/><path/>\`, props)` — the body is its
 * own template, compiled with no parent. The HTML parser has no self-closing
 * tag for an unknown element, so the second `<path>` became a CHILD of the
 * first, in the XHTML namespace:
 *
 *     <path d="A"><path d="B"></path></path>
 *
 * Nothing threw and nothing reached the console. The icon was simply invisible,
 * because a `<path>` in the XHTML namespace paints nothing — which is the worst
 * shape a rendering bug can take.
 */
import { describe, expect, it } from "vitest";
import { html } from "../../src/html.js";
import { render } from "../../src/render.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Render into a detached div and hand it back. */
function mount(value: unknown): HTMLDivElement {
	const host = document.createElement("div");
	render(value as never, host);
	return host;
}

describe("aurora > SVG content written as its own template", () => {
	it("keeps sibling paths as siblings", () => {
		const host = mount(html`<path d="A" /><path d="B" />`);
		const paths = host.querySelectorAll("path");

		expect(paths).toHaveLength(2);
		expect(paths[0]?.contains(paths[1] as Node)).toBe(false);
	});

	it("puts them in the SVG namespace, so they paint", () => {
		const host = mount(html`<path d="A" />`);
		expect(host.querySelector("path")?.namespaceURI).toBe(SVG_NS);
	});

	it("holds when the body is composed into an icon helper", () => {
		// The reported shape: a helper takes a template as its children.
		const icon = (children: unknown) =>
			html`<svg viewBox="0 0 24 24">${children}</svg>`;
		const host = mount(icon(html`<path d="A" /><path d="B" />`));

		const paths = host.querySelectorAll("path");
		expect(paths).toHaveLength(2);
		expect(paths[0]?.contains(paths[1] as Node)).toBe(false);
		expect(paths[0]?.namespaceURI).toBe(SVG_NS);
	});

	it("holds inside a reactive fragment, which is where it was found", () => {
		const icon = (children: unknown) =>
			html`<svg viewBox="0 0 24 24">${children}</svg>`;
		const body = html`<path d="A" /><path d="B" />`;
		const host = mount(html`<div>${() => icon(body)}</div>`);

		const paths = host.querySelectorAll("path");
		expect(paths).toHaveLength(2);
		expect(paths[0]?.contains(paths[1] as Node)).toBe(false);
	});

	it("still binds a slot inside the lifted content", () => {
		// The slot paths are collected against the shape that gets cloned, so
		// re-parsing must not lose them.
		const host = mount(html`<path d="${"M0 0"}" /><circle r="2" />`);
		expect(host.querySelector("path")?.getAttribute("d")).toBe("M0 0");
		expect(host.querySelectorAll("circle")).toHaveLength(1);
	});

	it("leaves ordinary HTML alone", () => {
		const host = mount(html`<p>one</p><p>two</p>`);
		const paragraphs = host.querySelectorAll("p");

		expect(paragraphs).toHaveLength(2);
		expect(paragraphs[0]?.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
	});

	it("leaves a template rooted at <svg> alone", () => {
		// The parser already handles that one; wrapping it would nest two.
		const host = mount(html`<svg viewBox="0 0 24 24"><path d="A" /></svg>`);
		expect(host.querySelectorAll("svg")).toHaveLength(1);
		expect(host.querySelector("path")?.namespaceURI).toBe(SVG_NS);
	});

	it("leaves a name that exists in both namespaces alone", () => {
		// `<a>` says nothing about which namespace was meant, and moving an
		// ordinary anchor into SVG would break every link written this way.
		const host = mount(html`<a href="/x">link</a>`);
		expect(host.querySelector("a")?.namespaceURI).toBe(
			"http://www.w3.org/1999/xhtml",
		);
	});
});
