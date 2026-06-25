import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	booleanCookie,
	cookie,
	cookieState,
	html,
	hydrate,
	renderToString,
	signal,
} from "../../src/index.js";

/**
 * Real-Chromium proof of the isomorphic cookie bridge: a cookie-backed signal
 * must produce the SAME markup at SSR and at hydration so the browser never
 * repaints the default state (the collapsed-sidebar flash). happy-dom can't be
 * trusted here — the SSR string is re-parsed by the real browser and hydrate
 * walks that live DOM. Mirrors fluveo's sidebar: a `booleanCookie` drives the
 * width class, with a sibling reactive text slot.
 */

let container: HTMLElement;
let warnSpy: ReturnType<typeof vi.spyOn>;

function clearCookies(): void {
	for (const part of document.cookie.split("; ")) {
		const name = part.split("=")[0];
		if (name) cookie.remove(name);
	}
}

beforeEach(() => {
	clearCookies();
	container = document.createElement("div");
	document.body.appendChild(container);
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warnSpy.mockRestore();
	container.remove();
	clearCookies();
});

function auroraWarnings(): string[] {
	return warnSpy.mock.calls
		.map((c: unknown[]) => String(c[0]))
		.filter((m: string) => m.includes("[aurora]"));
}

describe("aurora > browser > cookie-backed signal hydration (real Chromium)", () => {
	it("renders the persisted state identically at SSR and hydration (no flash)", () => {
		// The browser already holds the cookie the server set on a prior request.
		cookie.set("sidebar", "1");

		const factory = () => {
			const collapsed = cookieState("sidebar", false, booleanCookie);
			return html`<aside class="${() => (collapsed() ? "w-16" : "w-60")}"><span class="label">${() => (collapsed() ? "" : "Menu")}</span></aside>`;
		};

		// SSR string reflects the cookie (collapsed → w-16), not the default.
		const ssr = renderToString(factory());
		expect(ssr).toContain('class="w-16"');
		container.innerHTML = ssr;

		// Hydrate against that markup — same cookie, so no mismatch and no repaint.
		hydrate(container, factory);
		expect(auroraWarnings()).toEqual([]);
		expect(container.querySelector("aside")?.getAttribute("class")).toBe(
			"w-16",
		);
	});

	it("persists a toggle back to the cookie and updates the class reactively", () => {
		const collapsed = signal(false);
		const factory = () => {
			// One shared signal, but bound through a cookie so writes persist.
			const c = cookieState("sidebar", false, booleanCookie);
			// Mirror the external toggle into the cookie signal.
			c(collapsed());
			return html`<aside class="${() => (c() ? "w-16" : "w-60")}"></aside>`;
		};

		container.innerHTML = renderToString(factory());
		hydrate(container, factory);
		expect(container.querySelector("aside")?.getAttribute("class")).toBe(
			"w-60",
		);

		// A standalone cookie signal toggled in the live tree writes the cookie.
		const live = cookieState("sidebar", false, booleanCookie);
		live(true);
		expect(cookie.get("sidebar")).toBe("1");
		expect(live()).toBe(true);
	});
});
