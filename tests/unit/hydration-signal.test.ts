/**
 * The signal that says the client has taken over.
 *
 * Shaped after the runtimes that solve this — inertia's `inertia:*` custom
 * events, `turbo:load` / `turbo:frame-load`, `htmx:load` — with one addition
 * none of them needs and aurora does: a readable state beside the event, so a
 * listener attached after the fact does not wait forever. That is the race the
 * signal exists to remove, and an event alone reintroduces it one layer up.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	html,
	hydrate,
	hydrationState,
	whenHydrated,
} from "../../src/index.js";

function ssr(markup: string): HTMLElement {
	const host = document.createElement("div");
	host.innerHTML = markup;
	document.body.append(host);
	return host;
}

describe("aurora > hydration signal", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("fires aurora:hydrate on the root that was adopted", async () => {
		const seen: Element[] = [];
		const onHydrate = (e: Event) => {
			seen.push((e as CustomEvent).detail.container);
		};
		document.addEventListener("aurora:hydrate", onHydrate);
		try {
			const host = ssr("<p>hi</p>");
			hydrate(host, () => html`<p>hi</p>`);
			// It bubbles, which is what lets a page-level listener seeevery root.
			expect(seen).toEqual([host]);
		} finally {
			document.removeEventListener("aurora:hydrate", onHydrate);
		}
	});

	it("fires aurora:load once, after the roots settle", async () => {
		const onLoad = vi.fn();
		document.addEventListener("aurora:load", onLoad);
		try {
			hydrate(ssr("<p>a</p>"), () => html`<p>a</p>`);
			hydrate(ssr("<p>b</p>"), () => html`<p>b</p>`);
			// Not yet: settling between two roots would announce a page still
			// filling in.
			expect(onLoad).not.toHaveBeenCalled();
			await whenHydrated();
			expect(onLoad).toHaveBeenCalledTimes(1);
		} finally {
			document.removeEventListener("aurora:load", onLoad);
		}
	});

	it("resolves immediately for a listener that arrives late", async () => {
		// The failure mode of a pure event: subscribe after it fired and you
		// wait for ever. `document.readyState` is the DOM's own answer to it.
		hydrate(ssr("<p>x</p>"), () => html`<p>x</p>`);
		await whenHydrated();
		expect(hydrationState()).toBe("hydrated");

		const before = Date.now();
		await whenHydrated();
		expect(Date.now() - before).toBeLessThan(50);
	});

	it("settles the page even when a root throws, and says why", async () => {
		const onLoad = vi.fn();
		document.addEventListener("aurora:load", onLoad);
		try {
			const host = ssr("<p>boom</p>");
			expect(() =>
				hydrate(host, () => {
					throw new Error("factory blew up");
				}),
			).toThrow("factory blew up");

			// Withholding the signal on failure replaces a race with a silent
			// hang, and the waiter cannot tell the two apart.
			await whenHydrated();
			expect(onLoad).toHaveBeenCalledTimes(1);
			const { hydrationErrors } = await import("../../src/index.js");
			expect(String(hydrationErrors()[0])).toContain("factory blew up");
		} finally {
			document.removeEventListener("aurora:load", onLoad);
		}
	});

	it("starts over on a second wave, as Turbo does on each visit", async () => {
		hydrate(ssr("<p>1</p>"), () => html`<p>1</p>`);
		await whenHydrated();
		expect(hydrationState()).toBe("hydrated");

		// A client-side navigation hydrates again; the page is not "done"
		// because it was done once.
		hydrate(ssr("<p>2</p>"), () => html`<p>2</p>`);
		expect(hydrationState()).toBe("hydrating");
		await whenHydrated();
		expect(hydrationState()).toBe("hydrated");
	});
});
