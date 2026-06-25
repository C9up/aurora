import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, hydrate, renderToString, signal } from "../../src/index.js";

/**
 * Real-Chromium hydration of SVG icons — the case happy-dom can't catch. SVG is
 * foreign content; the browser's parser may produce a different node structure
 * for the SSR string than aurora's client `<template>` parse, desyncing slot
 * paths ("[aurora] hydration mismatch: slot … not found") and skipping bindings
 * (icons/nav not painted). Mirrors fluveo's header button: an SVG icon (a direct
 * nested template) with a class binding, followed by a sibling text slot.
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

describe("aurora > browser > SVG icon hydration (real Chromium)", () => {
	it("hydrates an SSR SVG icon + sibling slot without a path mismatch", () => {
		const cls = signal("size-4");
		const factory = () =>
			html`<button type="button">${html`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 ${cls}"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /></svg>`}<span class="label">${"Menu"}</span></button>`;

		container.innerHTML = renderToString(factory());
		hydrate(container, factory);

		// No hydration-mismatch warnings.
		expect(auroraWarnings()).toEqual([]);
		// The class binding landed on the real <svg> (not a shifted/wrong node).
		cls("size-6");
		expect(container.querySelector("svg")?.getAttribute("class")).toContain(
			"size-6",
		);
		// The sibling text slot is intact.
		expect(container.querySelector("span.label")?.textContent).toBe("Menu");
	});
});
