import { describe, expect, it } from "vitest";
import {
	html,
	hydrate,
	render,
	renderToString,
	signal,
} from "../../src/index.js";

/**
 * Real-Chromium half of the nested-template-in-attribute refusal: the server
 * no longer ships the markup that broke out of `title`, the client refuses it
 * too, and the string a prop should pass instead stays a single attribute once
 * the browser parses it.
 */

const BREAKOUT = '" autofocus onfocus="alert(document.domain)';

function codeOf(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return Reflect.get(Object(error), "code");
	}
	return undefined;
}

describe("aurora > browser > a nested template as an attribute value", () => {
	it("is refused by the server and by the client render", () => {
		const make = () => html`<input title="${html`${BREAKOUT}`}">`;
		expect(codeOf(() => renderToString(make()))).toBe(
			"E_AURORA_TEMPLATE_IN_ATTRIBUTE",
		);
		const host = document.createElement("div");
		expect(codeOf(() => render(make(), host))).toBe(
			"E_AURORA_TEMPLATE_IN_ATTRIBUTE",
		);
	});

	it("is refused when a hydrated attribute later receives one", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const title = signal<unknown>(BREAKOUT);
		const make = () => html`<input title="${title}">`;
		host.innerHTML = renderToString(make());
		hydrate(host, make);
		const input = host.querySelector("input");
		expect(input?.getAttributeNames()).toEqual(["title"]);
		expect(input?.getAttribute("title")).toBe(BREAKOUT);
		expect(codeOf(() => title(html`${BREAKOUT}`))).toBe(
			"E_AURORA_TEMPLATE_IN_ATTRIBUTE",
		);
		expect(input?.getAttributeNames()).toEqual(["title"]);
		host.remove();
	});
});
