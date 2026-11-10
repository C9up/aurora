import { describe, expect, it } from "vitest";
import { html } from "../../src/html.js";
import { hydrate } from "../../src/hydrate.js";
import { signal } from "../../src/reactive.js";
import { render } from "../../src/render.js";
import { renderToString } from "../../src/ssr.js";
import type { TemplateResult } from "../../src/types.js";

/**
 * Three URL positions the guard did not know: an SVG animation that sets
 * `href` (`<set attributeName="href" to="javascript:…">`), a refresh in
 * `<meta http-equiv="refresh" content="0;url=…">`, and `<base href>`, which
 * rebases every relative URL and script on the page.
 */

const JS = "javascript:alert(1)";

/** The attribute as the browser reads the server's markup. */
function onServer(result: TemplateResult, selector: string, attribute: string) {
	const host = document.createElement("div");
	host.innerHTML = renderToString(result);
	return host.querySelector(selector)?.getAttribute(attribute) ?? null;
}

function onClient(result: TemplateResult, selector: string, attribute: string) {
	const host = document.createElement("div");
	render(result, host);
	return host.querySelector(selector)?.getAttribute(attribute) ?? null;
}

function bothPaths(
	make: () => TemplateResult,
	selector: string,
	attribute: string,
): [string | null, string | null] {
	return [
		onServer(make(), selector, attribute),
		onClient(make(), selector, attribute),
	];
}

function codeOf(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return Reflect.get(Object(error), "code");
	}
	return undefined;
}

describe("url guard > SVG animation values", () => {
	it("neutralises to, from and by on <set> and <animate>", () => {
		for (const attribute of ["to", "from", "by"]) {
			const strings = [
				`<svg><a><set attributeName="href" ${attribute}="`,
				'"/><text>x</text></a></svg>',
			];
			const make = () => html(Object.assign(strings, { raw: strings }), JS);
			expect(bothPaths(make, "set", attribute)).toEqual([
				`unsafe:${JS}`,
				`unsafe:${JS}`,
			]);
		}
		const animate = () =>
			html`<svg><a><animate attributeName="xlink:href" to="${JS}"/></a></svg>`;
		expect(bothPaths(animate, "animate", "to")).toEqual([
			`unsafe:${JS}`,
			`unsafe:${JS}`,
		]);
	});

	it("neutralises each unsafe item of a values list", () => {
		const make = () =>
			html`<svg><a><animate attributeName="href" values="${`/a;${JS}; data:text/html,x`}"/></a></svg>`;
		expect(bothPaths(make, "animate", "values")).toEqual([
			`/a;unsafe:${JS};unsafe: data:text/html,x`,
			`/a;unsafe:${JS};unsafe: data:text/html,x`,
		]);
	});

	it("neutralises a values list the template and a slot assemble", () => {
		const make = () =>
			html`<svg><animate attributeName="href" values="/a;${"javascript"}:alert(1)"/></svg>`;
		expect(bothPaths(make, "animate", "values")).toEqual([
			`/a;unsafe:${JS}`,
			`/a;unsafe:${JS}`,
		]);
	});

	it("leaves ordinary animation values alone", () => {
		const make = () =>
			html`<svg><rect><animate attributeName="opacity" values="${"0;1;0.5"}" to=${"1"}/></rect></svg>`;
		expect(bothPaths(make, "animate", "values")).toEqual([
			"0;1;0.5",
			"0;1;0.5",
		]);
	});

	it("neutralises a value a signal later swaps in", () => {
		const to = signal("/safe");
		const host = document.createElement("div");
		const make = () =>
			html`<svg><a><set attributeName="href" to="${to}"/></a></svg>`;
		host.innerHTML = renderToString(make());
		hydrate(host, make);
		to(JS);
		expect(host.querySelector("set")?.getAttribute("to")).toBe(`unsafe:${JS}`);
	});
});

describe("url guard > meta refresh", () => {
	it("neutralises an unsafe refresh target", () => {
		for (const content of [`0;url=${JS}`, `0; URL='${JS}'`, `5, ${JS}`]) {
			const make = () => html`<meta http-equiv="refresh" content="${content}">`;
			expect(bothPaths(make, "meta", "content")).toEqual([
				`unsafe:${content}`,
				`unsafe:${content}`,
			]);
		}
	});

	it("neutralises a target the template and a slot assemble", () => {
		const make = () =>
			html`<meta http-equiv="refresh" content="0;url=${"javascript:alert(1)"}">`;
		expect(bothPaths(make, "meta", "content")).toEqual([
			`unsafe:0;url=${JS}`,
			`unsafe:0;url=${JS}`,
		]);
	});

	it("leaves a safe refresh and ordinary meta content alone", () => {
		for (const content of [
			"0;url=/next",
			"30",
			"Learn javascript: the basics",
			"width=device-width,initial-scale=1",
		]) {
			const make = () => html`<meta name="x" content="${content}">`;
			expect(bothPaths(make, "meta", "content")).toEqual([content, content]);
		}
	});
});

describe("url guard > <base href>", () => {
	it("refuses a slot in base href on both paths", () => {
		const make = () => html`<base href="${"https://evil.test/"}">`;
		expect(codeOf(() => renderToString(make()))).toBe(
			"E_AURORA_SLOT_IN_BASE_URL",
		);
		expect(codeOf(() => render(make(), document.createElement("div")))).toBe(
			"E_AURORA_SLOT_IN_BASE_URL",
		);
	});

	it("refuses the .href property on base too", () => {
		const make = () => html`<base .href=${"https://evil.test/"}>`;
		expect(codeOf(() => renderToString(make()))).toBe(
			"E_AURORA_SLOT_IN_BASE_URL",
		);
		expect(codeOf(() => render(make(), document.createElement("div")))).toBe(
			"E_AURORA_SLOT_IN_BASE_URL",
		);
	});

	it("still allows a slot in base target", () => {
		expect(renderToString(html`<base target="${"_blank"}">`)).toBe(
			'<base target="_blank">',
		);
	});
});
