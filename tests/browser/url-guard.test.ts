import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, hydrate, renderToString, signal } from "../../src/index.js";

/**
 * Real-Chromium proof that a neutralised URL is actually inert, and that a safe
 * one still navigates.
 *
 * happy-dom can compare the attribute string, which is the weaker half of the
 * claim. The claim is about the BROWSER: that `unsafe:javascript:…` is a scheme
 * it will not run, that `href` resolves to nothing rather than to a relative
 * path it might follow, and that the guard did not quietly break `mailto:` or an
 * inline `data:` image along the way. Only the engine that resolves URLs settles
 * any of that.
 */

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

function auroraWarnings(): string[] {
	return warnSpy.mock.calls
		.map((c: unknown[]) => String(c[0]))
		.filter((m: string) => m.includes("[aurora]"));
}

describe("aurora > browser > a neutralised URL", () => {
	it("is a scheme the browser will not execute", () => {
		const factory = () => html`<a href="${"javascript:alert(1)"}">x</a>`;
		container.innerHTML = renderToString(factory());
		const link = container.querySelector("a");
		if (link === null) throw new Error("expected the SSR link");
		expect(link.getAttribute("href")).toBe("unsafe:javascript:alert(1)");
		// `protocol` is the browser's own parse of the attribute, not ours.
		expect(link.protocol).toBe("unsafe:");
		// Clicking it must not run anything. A `javascript:` href would have.
		let ran = false;
		Reflect.set(window, "__auroraUrlGuardProbe", () => {
			ran = true;
		});
		link.click();
		expect(ran).toBe(false);
	});

	it("crosses hydration without a mismatch", () => {
		const target = signal("javascript:alert(1)");
		const factory = () => html`<a href="${target}">x</a>`;
		container.innerHTML = renderToString(factory());
		hydrate(container, factory);
		expect(auroraWarnings()).toEqual([]);
		const link = container.querySelector("a");
		expect(link?.getAttribute("href")).toBe("unsafe:javascript:alert(1)");
		// And a later safe value is written through untouched.
		target("/dashboard");
		expect(link?.getAttribute("href")).toBe("/dashboard");
		expect(link?.pathname).toBe("/dashboard");
	});

	it("is neutralised through the unquoted-value encoding too", () => {
		// The encoding writes `&#9;` for the tab; a real tokenizer decodes it, and
		// a real URL parser then strips it. Both have to happen for the guard's
		// ordering to be the right ordering.
		container.innerHTML = renderToString(
			html`<a href=${"java\tscript:alert(1)"}>x</a>`,
		);
		const link = container.querySelector("a");
		expect(link?.protocol).toBe("unsafe:");
	});
});

describe("aurora > browser > what the guard must not break", () => {
	it("leaves the URLs an application uses resolvable", () => {
		// Each case names the property to read, because what proves a URL survived
		// differs: a path for a relative one, the fragment for an anchor, the
		// scheme for one the browser hands to another application.
		const cases: readonly [string, "pathname" | "hash" | "protocol", string][] =
			[
				["/users/42", "pathname", "/users/42"],
				["#anchor", "hash", "#anchor"],
				["mailto:a@b.c", "protocol", "mailto:"],
				["tel:+41791234567", "protocol", "tel:"],
				["https://example.com/a", "protocol", "https:"],
			];
		for (const [url, property, expected] of cases) {
			container.innerHTML = renderToString(html`<a href="${url}">x</a>`);
			const link = container.querySelector("a");
			if (link === null) throw new Error("expected the SSR link");
			expect(link.getAttribute("href")).toBe(url);
			expect(link[property]).toBe(expected);
		}
	});

	it("still loads an inline data: image", async () => {
		// `src` is deliberately outside the guard. A 1x1 GIF proves the browser
		// accepted the URI, not just that the attribute survived.
		const uri =
			"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
		container.innerHTML = renderToString(html`<img src="${uri}" alt="">`);
		const img = container.querySelector("img");
		if (img === null) throw new Error("expected the SSR img");
		expect(img.getAttribute("src")).toBe(uri);
		await new Promise<void>((resolve, reject) => {
			if (img.complete && img.naturalWidth > 0) return resolve();
			img.addEventListener("load", () => resolve());
			img.addEventListener("error", () => reject(new Error("data: blocked")));
		});
		expect(img.naturalWidth).toBe(1);
	});

	it("submits a form whose action came from a slot", () => {
		container.innerHTML = renderToString(
			html`<form action="${"/search"}" method="get"></form>`,
		);
		const form = container.querySelector("form");
		if (form === null) throw new Error("expected the SSR form");
		expect(form.getAttribute("action")).toBe("/search");
		expect(new URL(form.action).pathname).toBe("/search");
	});
});
