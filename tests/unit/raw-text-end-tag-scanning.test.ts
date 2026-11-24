/**
 * After a raw-text element closes, the rest of the template is markup again.
 *
 * The template is prepared (unquoted values quoted, directives found) by feeding
 * the scanner one character at a time, and the scanner only recognised a
 * raw-text element's end tag arriving whole: after `</iframe>`, `</textarea>`,
 * `</title>` or `</script>`, every later slot was read as that element's text —
 * an unquoted URL left unguarded and unquoted, a directive left unread.
 */
import { describe, expect, it } from "vitest";
import { html, renderToString } from "../../src/index.js";

const URL = "javascript:alert(1)";

describe("aurora > template preparation after a raw-text element", () => {
	it.each([
		["iframe", html`<iframe></iframe><a href=${URL}>x</a>`],
		["textarea", html`<textarea>a < b</textarea><a href=${URL}>x</a>`],
		["title", html`<title>t</title><a href=${URL}>x</a>`],
		["script", html`<script>if (a < b) {}</script><a href=${URL}>x</a>`],
		["style", html`<style>a > b {}</style><a href=${URL}>x</a>`],
		["noscript-like xmp", html`<xmp>x</xmp><a href=${URL}>x</a>`],
		["upper-case end tag", html`<iframe></IFRAME><a href=${URL}>x</a>`],
	])("guards and quotes an unquoted URL after </%s>", (_name, template) => {
		const markup = renderToString(template);
		expect(markup).toContain(`<a href="unsafe:${URL}">`);
		expect(markup).not.toContain(`href=${URL}`);
	});

	it("keeps an empty unquoted value from swallowing the next attribute", () => {
		const markup = renderToString(
			html`<textarea></textarea><div title=${""} data-note="${"x onmouseover=alert(1) y"}"></div>`,
		);
		expect(markup).toContain('title=""');
		expect(markup).not.toMatch(/title=\s*data-note/);
	});

	it("still finds a directive written after a raw-text element", () => {
		let called = 0;
		const markup = renderToString(
			html`<iframe></iframe><button @click=${() => {
				called += 1;
			}}>go</button>`,
		);
		expect(markup).not.toContain("@click");
		expect(called).toBe(0);
	});

	it("does not leave on a longer name that only starts like the end tag", () => {
		// `</iframex` is text inside the iframe, so the slot after it is too.
		expect(() =>
			renderToString(html`<iframe></iframex <a href=${URL}>x</a></iframe>`),
		).toThrow();
	});
});
