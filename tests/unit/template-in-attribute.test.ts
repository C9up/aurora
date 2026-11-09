import { describe, expect, it } from "vitest";
import { html } from "../../src/html.js";
import { hydrate } from "../../src/hydrate.js";
import { signal } from "../../src/reactive.js";
import { render } from "../../src/render.js";
import { renderToString } from "../../src/ssr.js";
import type { TemplateResult } from "../../src/types.js";

/**
 * A nested template has no meaning as an attribute value: the server spliced
 * its markup in raw — escaped for text, so a quote in the data ended the
 * attribute — and the client wrote "[object Object]". Both paths refuse it.
 */

const CODE = "E_AURORA_TEMPLATE_IN_ATTRIBUTE";
const BREAKOUT = '" autofocus onfocus="alert(document.domain)';
const UNQUOTED = "x onfocus=alert(1) autofocus";

type Make = () => TemplateResult;

function codeOf(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return Reflect.get(Object(error), "code");
	}
	return undefined;
}

function onClient(make: Make): unknown {
	const host = document.createElement("div");
	document.body.appendChild(host);
	try {
		return codeOf(() => render(make(), host));
	} finally {
		host.remove();
	}
}

function refusedOnBothPaths(make: Make): void {
	expect(codeOf(() => renderToString(make()))).toBe(CODE);
	expect(onClient(make)).toBe(CODE);
}

describe("a nested template in an attribute position", () => {
	it("is refused in a quoted value — the probe that broke out of title", () => {
		refusedOnBothPaths(() => html`<input title="${html`${BREAKOUT}`}">`);
	});

	it("is refused in a single-quoted value", () => {
		refusedOnBothPaths(() => html`<input title='${html`${BREAKOUT}`}'>`);
	});

	it("is refused in an unquoted value", () => {
		refusedOnBothPaths(() => html`<input title=${html`${UNQUOTED}`}>`);
	});

	it("is refused when joined with static text", () => {
		refusedOnBothPaths(() => html`<p title="a ${html`${BREAKOUT}`} b">x</p>`);
	});

	it("is refused inside an array", () => {
		refusedOnBothPaths(
			() => html`<p title="${["ok", html`${BREAKOUT}`]}">x</p>`,
		);
	});

	it("is refused inside a nested array", () => {
		refusedOnBothPaths(() => html`<p title="${[["ok", [html`x`]]]}">x</p>`);
	});

	it("is refused behind a signal or an accessor", () => {
		const label = signal<unknown>(html`${BREAKOUT}`);
		refusedOnBothPaths(() => html`<p title="${label}">x</p>`);
		refusedOnBothPaths(() => html`<p title="${() => html`${BREAKOUT}`}">x</p>`);
	});

	it("is refused in a URL attribute", () => {
		refusedOnBothPaths(() => html`<a href="${html`/x`}">x</a>`);
	});

	it("is refused in .value on an input", () => {
		refusedOnBothPaths(() => html`<input .value=${html`${BREAKOUT}`}>`);
		refusedOnBothPaths(() => html`<input .value="${html`${BREAKOUT}`}">`);
	});

	it("is refused in .value on a textarea", () => {
		refusedOnBothPaths(
			() =>
				html`<textarea .value=${html`</textarea><b>${"x"}</b>`}></textarea>`,
		);
	});

	it("is refused when an attribute signal later swaps one in", () => {
		const host = document.createElement("div");
		const title = signal<unknown>("plain");
		render(html`<p title="${title}">x</p>`, host);
		expect(host.querySelector("p")?.getAttribute("title")).toBe("plain");
		expect(codeOf(() => title(html`${BREAKOUT}`))).toBe(CODE);
		expect(host.querySelector("p")?.getAttribute("title")).toBe("plain");
	});

	it("is refused when a reactive slot of a hydrated attribute swaps one in", () => {
		const host = document.createElement("div");
		const title = signal<unknown>("plain");
		const make = (): TemplateResult => html`<p title="a ${title}">x</p>`;
		host.innerHTML = renderToString(make());
		hydrate(host, make);
		expect(codeOf(() => title(html`${BREAKOUT}`))).toBe(CODE);
		expect(host.querySelector("p")?.getAttribute("title")).toBe("a plain");
	});

	it("still renders a template in a text slot and plain values in attributes", () => {
		const out = renderToString(
			html`<p title="${'say "hi"'}" class=${"a b"}>${html`<b>${"<x>"}</b>`}</p>`,
		);
		expect(out).toContain('title="say &quot;hi&quot;"');
		expect(out).toContain("class=a&#32;b");
		expect(out).toContain("<b><!--$-->&lt;x&gt;<!--/$--></b>");
	});
});
