import { describe, expect, it } from "vitest";
import { html } from "../../src/html.js";
import { signal } from "../../src/reactive.js";
import { render } from "../../src/render.js";
import { renderToString } from "../../src/ssr.js";

/**
 * A URL interpolated into an attribute the browser navigates to.
 *
 * `navigate()` has refused `javascript:` since it was written; the markup never
 * applied the same rule, so the one attribute that actually navigates was the
 * one place the policy did not reach. Unsafe schemes are neutralised rather than
 * rejected — a URL in an `href` is usually data, and throwing there trades an
 * XSS for a blank page.
 *
 * Every case is checked on both render paths. They compute the guard from
 * different material — the server from the slot that opens the value, the client
 * from the whole joined value — so agreement is the thing worth asserting.
 */

function ssrValue(markup: string, attribute: string): string | null {
	const host = document.createElement("div");
	host.innerHTML = markup;
	return host.firstElementChild?.getAttribute(attribute) ?? null;
}

function clientValue(
	result: ReturnType<typeof html>,
	attribute: string,
): string | null {
	const host = document.createElement("div");
	document.body.appendChild(host);
	try {
		render(result, host);
		return host.firstElementChild?.getAttribute(attribute) ?? null;
	} finally {
		host.remove();
	}
}

function bothPaths(
	make: () => ReturnType<typeof html>,
	attribute: string,
): string | null {
	const server = ssrValue(renderToString(make()), attribute);
	expect(server).toBe(clientValue(make(), attribute));
	return server;
}

describe("url guard > a scheme that executes", () => {
	it("is neutralised in href, on both paths", () => {
		expect(
			bothPaths(() => html`<a href="${"javascript:alert(1)"}">x</a>`, "href"),
		).toBe("unsafe:javascript:alert(1)");
	});

	it("covers vbscript: and data:", () => {
		expect(
			bothPaths(() => html`<a href="${"vbscript:msgbox"}">x</a>`, "href"),
		).toBe("unsafe:vbscript:msgbox");
		expect(
			bothPaths(
				() => html`<a href="${"data:text/html,<script>"}">x</a>`,
				"href",
			),
		).toBe("unsafe:data:text/html,<script>");
	});

	it("is not fooled by the characters a browser strips from a URL", () => {
		// A browser drops tab / newline / CR from anywhere in a URL and trims
		// leading control characters before resolving the scheme, so each of these
		// executes as `javascript:` while reading as something else.
		//
		// Asserted per path rather than by comparing the two: a NUL cannot be
		// represented in an attribute at all — every parser turns it into U+FFFD —
		// so byte equality between markup and `setAttribute` is not a property
		// that exists here. What must hold is that the scheme no longer opens the
		// value, whichever path wrote it.
		for (const url of [
			"java\tscript:alert(1)",
			"java\nscript:alert(1)",
			"java\rscript:alert(1)",
			"\u0000javascript:alert(1)",
			"\u0001\u0002javascript:alert(1)",
			"  javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
		]) {
			const make = () => html`<a href="${url}">x</a>`;
			expect(
				ssrValue(renderToString(make()), "href")?.startsWith("unsafe:"),
			).toBe(true);
			expect(clientValue(make(), "href")?.startsWith("unsafe:")).toBe(true);
		}
	});

	it("survives the unquoted attribute encoding, which happens after the guard", () => {
		// The order matters: an unquoted value encodes the tab as `&#9;`, which the
		// browser decodes back before resolving the scheme. Checked after escaping,
		// the URL reads as a harmless literal and sails through.
		const markup = renderToString(
			html`<a href=${"java\tscript:alert(1)"}>x</a>`,
		);
		expect(ssrValue(markup, "href")?.startsWith("unsafe:")).toBe(true);
	});

	it("is guarded on action and formaction too", () => {
		expect(
			bothPaths(() => html`<form action="${"javascript:x"}"></form>`, "action"),
		).toBe("unsafe:javascript:x");
		expect(
			bothPaths(
				() => html`<button formaction="${"javascript:x"}">g</button>`,
				"formaction",
			),
		).toBe("unsafe:javascript:x");
	});

	it("is guarded again when a signal changes it after mount", () => {
		const target = signal("/safe");
		const host = document.createElement("div");
		document.body.appendChild(host);
		try {
			render(html`<a href="${target}">x</a>`, host);
			expect(host.firstElementChild?.getAttribute("href")).toBe("/safe");
			target("javascript:alert(1)");
			expect(host.firstElementChild?.getAttribute("href")).toBe(
				"unsafe:javascript:alert(1)",
			);
		} finally {
			host.remove();
		}
	});
});

describe("url guard > what it must leave alone", () => {
	it("passes every URL an application actually uses", () => {
		for (const url of [
			"/users/42",
			"https://example.com/a?b=c#d",
			"mailto:a@b.c",
			"tel:+41791234567",
			"#anchor",
			"?page=2",
			"//cdn.example.com/x",
			"../up",
			"",
		]) {
			expect(bothPaths(() => html`<a href="${url}">x</a>`, "href")).toBe(url);
		}
	});

	it("leaves src alone, so an inline data: image still works", () => {
		// `data:` is how an inline image is written. Blocking it on `src` would
		// break legitimate markup to guard a position that does not navigate.
		const uri = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
		expect(bothPaths(() => html`<img src="${uri}" alt="">`, "src")).toBe(uri);
	});

	it("does not mistake a scheme inside a query string for the target", () => {
		const url = "/go?next=javascript:alert(1)";
		expect(bothPaths(() => html`<a href="${url}">x</a>`, "href")).toBe(url);
	});

	it("reads the whole value when the template supplies part of it", () => {
		// The server guards the slot that OPENS the value; the client guards the
		// joined value. Both must land on the same answer either way.
		expect(
			bothPaths(() => html`<a href="/go?u=${"javascript:x"}">x</a>`, "href"),
		).toBe("/go?u=javascript:x");
		expect(
			bothPaths(
				() => html`<a href="${"javascript:"}${"alert(1)"}">x</a>`,
				"href",
			),
		).toBe("unsafe:javascript:alert(1)");
	});
});
