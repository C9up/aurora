import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, hydrate, renderToString, signal } from "../../src/index.js";

/**
 * Real-Chromium proof that a boolean attribute crosses SSR.
 *
 * jsdom can assert the attribute is there, but not that it MATTERS: the defect
 * was a flash of content the server said to hide, and only a browser that
 * actually applies the UA stylesheet and computes visibility can show that the
 * markup, on its own and before any JavaScript binds to it, is already in the
 * state the application asked for.
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

describe("aurora > browser > boolean attributes across SSR", () => {
	it("renders hidden markup that the browser never paints", () => {
		const collapsed = signal(true);
		const factory = () =>
			html`<section ?hidden="${collapsed}"><p>secret</p></section>`;

		// Server markup only — no hydration yet. This is the frame the user saw.
		container.innerHTML = renderToString(factory());
		const section = container.querySelector("section");
		if (section === null) throw new Error("expected the SSR section");
		expect(section.checkVisibility()).toBe(false);
		expect(getComputedStyle(section).display).toBe("none");

		hydrate(container, factory);
		expect(auroraWarnings()).toEqual([]);
		// Hydration confirms rather than corrects.
		expect(section.checkVisibility()).toBe(false);

		// And the binding is live: expanding paints it.
		collapsed(false);
		expect(section.checkVisibility()).toBe(true);
	});

	it("ships a disabled control the browser refuses before hydration", () => {
		const busy = signal(true);
		const factory = () =>
			html`<button type="button" ?disabled="${busy}">Send</button>`;

		container.innerHTML = renderToString(factory());
		const button = container.querySelector("button");
		if (button === null) throw new Error("expected the SSR button");
		// The real property, computed by the browser from the attribute — an
		// early click is refused instead of firing a half-bound handler.
		expect(button.disabled).toBe(true);
		expect(button.matches(":disabled")).toBe(true);

		hydrate(container, factory);
		expect(auroraWarnings()).toEqual([]);
		expect(button.disabled).toBe(true);

		busy(false);
		expect(button.disabled).toBe(false);
	});
});
