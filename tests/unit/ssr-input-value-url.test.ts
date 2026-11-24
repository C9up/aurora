import { describe, expect, it } from "vitest";
import { html } from "../../src/html.js";
import { hydrate } from "../../src/hydrate.js";
import { render } from "../../src/render.js";
import { renderToString } from "../../src/ssr.js";
import type { TemplateResult } from "../../src/types.js";

/**
 * The server holds an `<input .value>` back until the tag closes, to check it
 * against the input's `type`. The rest of the tag goes through the URL guard
 * like every other tag: `formaction` is judged wherever `.value` sits.
 */

const JS_URL = "javascript:alert(document.domain)";
const INERT = `unsafe:${JS_URL}`;

function formaction(markup: string): string | null | undefined {
	const host = document.createElement("div");
	host.innerHTML = markup;
	return host.querySelector("input")?.getAttribute("formaction");
}

describe("ssr > `.value` on an input and the URL guard", () => {
	const views: ReadonlyArray<
		readonly [string, (target: string) => TemplateResult]
	> = [
		[
			"after .value",
			(target) =>
				html`<form method="post"><input type="submit" .value="${"Save"}" formaction="${target}"></form>`,
		],
		[
			"before .value",
			(target) =>
				html`<form method="post"><input type="submit" formaction="${target}" .value="${"Save"}"></form>`,
		],
		[
			"unquoted, after .value",
			(target) =>
				html`<form><input .value=${"Save"} formaction=${target}></form>`,
		],
	];

	it("agrees on the server, after hydration and on the client", () => {
		for (const [label, view] of views) {
			const out = renderToString(view(JS_URL));
			expect(formaction(out), label).toBe(INERT);
			expect(out, label).toContain('value="Save"');
			const host = document.createElement("div");
			host.innerHTML = out;
			hydrate(host, () => view(JS_URL));
			expect(formaction(host.innerHTML), label).toBe(INERT);
			const client = document.createElement("div");
			render(view(JS_URL), client);
			expect(formaction(client.innerHTML), label).toBe(INERT);
		}
	});

	it("judges a value split over static text and a slot whole", () => {
		const out = renderToString(
			html`<input type="image" .value="${"x"}" formaction="java${"script:alert(1)"}">`,
		);
		expect(formaction(out)).toBe("unsafe:javascript:alert(1)");
	});

	it("leaves a safe URL alone, and still checks the input's type at the end of the tag", () => {
		expect(
			formaction(
				renderToString(html`<input .value="${"a"}" formaction="${"/save"}">`),
			),
		).toBe("/save");
		expect(() =>
			renderToString(
				html`<input .value="${"C:/x"}" formaction="${"/up"}" type="file">`,
			),
		).toThrowError(
			expect.objectContaining({ code: "E_AURORA_FILE_INPUT_VALUE" }),
		);
	});

	it("still writes a textarea's value after its tag", () => {
		expect(
			renderToString(
				html`<textarea .value="${"a < b"}" title="${"t"}"></textarea>`,
			),
		).toBe('<textarea title="t">a &lt; b</textarea>');
	});
});
