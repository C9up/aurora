import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { html, renderToString } from "../../src/index.js";

/**
 * Where HTML resumes inside SVG and MathML.
 *
 * Suspending the raw-text rules for everything under `<svg>` was too broad. An
 * HTML integration point — `foreignObject`, `desc`, `title` in SVG, and
 * `annotation-xml` in MathML — puts the parser back into HTML, so a `<script>`
 * there is a real script with real raw text. The server accepted the slot and
 * emitted executable JavaScript.
 *
 * The payload is what makes it run rather than merely land: aurora anchors a text
 * slot with `<!--$-->`, and inside a script `<!--` opens a legacy HTML-like
 * comment that ends at the LINE break. So a value beginning with a newline closes
 * the comment and everything after it executes.
 *
 * Asserted in a real browser because the whole claim is about what a parser and a
 * script engine do with the bytes.
 */

const PROBE = "__auroraForeignObjectProbe";

let container: HTMLElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	Reflect.deleteProperty(window, PROBE);
});

afterEach(() => {
	container.remove();
	Reflect.deleteProperty(window, PROBE);
});

/**
 * Put markup in the document the way a server response would, with scripts that
 * actually run — `innerHTML` never executes one.
 */
function land(markup: string): void {
	const parsed = new DOMParser().parseFromString(
		`<!doctype html><body>${markup}`,
		"text/html",
	);
	for (const node of Array.from(parsed.body.childNodes)) {
		container.appendChild(document.importNode(node, true));
	}
	// importNode does not mark scripts as executable, so re-create them the way
	// the parser would have.
	for (const stale of Array.from(container.querySelectorAll("script"))) {
		const live = document.createElement("script");
		live.textContent = stale.textContent;
		stale.replaceWith(live);
	}
}

describe("aurora > browser > an HTML integration point inside SVG", () => {
	it("is where a script becomes a real script, so the slot is refused", () => {
		// The payload that ran: `<!--` opens a comment inside a script and the
		// newline ends it.
		const payload = `\nwindow.${PROBE} = 42`;
		expect(() =>
			renderToString(
				html`<svg><foreignObject><script>${payload}</script></foreignObject></svg>`,
			),
		).toThrowError(/cannot go inside <script>/);
		expect(Reflect.get(window, PROBE)).toBeUndefined();
	});

	it("would have executed what the server used to emit", () => {
		// The other half of the proof: the old markup, landed in this browser, runs.
		// Without it, "refused" says nothing about whether it mattered.
		land(
			`<svg><foreignObject><script><!--$-->\nwindow.${PROBE} = 42<!--/$--></script></foreignObject></svg>`,
		);
		expect(Reflect.get(window, PROBE)).toBe(42);
	});

	it("covers desc and title, which are integration points too", () => {
		for (const markup of [
			() => html`<svg><desc><script>${"var a"}</script></desc></svg>`,
			() => html`<svg><title><script>${"var a"}</script></title></svg>`,
			() =>
				html`<svg><foreignObject><textarea>${"v"}</textarea></foreignObject></svg>`,
			() =>
				html`<svg><foreignObject><style>${"a{}"}</style></foreignObject></svg>`,
		]) {
			expect(() => renderToString(markup())).toThrowError(/cannot go inside/);
		}
	});

	it("covers MathML's annotation-xml", () => {
		expect(() =>
			renderToString(
				html`<math><annotation-xml encoding="text/html"><script>${"var a"}</script></annotation-xml></math>`,
			),
		).toThrowError(/cannot go inside <script>/);
	});
});

describe("aurora > browser > plain SVG content, which is not HTML", () => {
	it("still takes a text slot in <svg><title>", () => {
		// The chart this has to keep working: in foreign content the tokenizer
		// never switches state, so this is an ordinary text slot.
		const markup = renderToString(
			html`<svg viewBox="0 0 10 10"><title>${"Revenue"}</title><rect/></svg>`,
		);
		land(markup);
		expect(container.querySelector("svg title")?.textContent).toContain(
			"Revenue",
		);
	});

	it("takes one in a foreignObject's HTML content", () => {
		const markup = renderToString(
			html`<svg><foreignObject><div>${"ok"}</div></foreignObject></svg>`,
		);
		land(markup);
		expect(container.querySelector("foreignObject div")?.textContent).toContain(
			"ok",
		);
	});

	it("goes back to SVG rules once the integration point closes", () => {
		expect(() =>
			renderToString(
				html`<svg><foreignObject></foreignObject><title>${"T"}</title></svg>`,
			),
		).not.toThrow();
	});
});
