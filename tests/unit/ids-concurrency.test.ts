/**
 * Two responses rendering at the same time.
 *
 * `renderPage` resets the sequence and then awaits — the page module, the
 * shared props, the component itself. With one counter per PROCESS, a second
 * request arriving inside any of those awaits resets it under the first, and
 * that response ships ids its own browser will never find.
 *
 * Nothing about it is visible sequentially, which is why the first round of
 * tests missed it and an external audit did not.
 */

import { describe, expect, it } from "vitest";
import { component, html, uid } from "../../src/index.js";
import { Pages } from "../../src/Pages.js";
import { renderPage } from "../../src/server/renderPage.js";

/** The slice of a response `renderPage` writes to. */
function fakeContext(): {
	ctx: Parameters<typeof renderPage>[0];
	body: () => string;
} {
	let sent = "";
	const ctx = {
		request: { cookie: () => undefined, header: () => undefined },
		response: {
			header: () => undefined,
			send: (payload: unknown) => {
				sent = String(payload);
			},
		},
	};
	return {
		ctx: ctx as unknown as Parameters<typeof renderPage>[0],
		body: () => sent,
	};
}

/** A Pages whose resolve() waits, so two renders genuinely interleave. */
function slowPages(delay: () => Promise<void>): Pages {
	const Page = component(() => {
		const id = uid("trigger");
		return html`<span id="${id}">?</span>`;
	});
	const pages = new Pages({ root: "/tmp/unused" });
	Object.defineProperty(pages, "resolve", {
		value: async () => {
			await delay();
			return Page;
		},
	});
	return pages;
}

describe("aurora > ids under concurrent SSR", () => {
	it("gives each render its own sequence", async () => {
		// The first render is held inside `resolve()` while the second runs to
		// completion — the exact interleaving a busy server produces.
		let releaseFirst = (): void => {};
		const held = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = fakeContext();
		const second = fakeContext();

		const firstRender = renderPage(
			first.ctx,
			slowPages(() => held),
			"Page",
			{},
		);
		const secondRender = renderPage(
			second.ctx,
			slowPages(async () => {}),
			"Page",
			{},
		);

		await secondRender;
		releaseFirst();
		await firstRender;

		// Both start at 1: neither reset the other's counter, and neither
		// carried on from it.
		expect(first.body()).toContain('id="trigger-1"');
		expect(second.body()).toContain('id="trigger-1"');
	});

	it("keeps counting within one render, across its awaits", async () => {
		const Page = component(
			() => html`<i id="${uid("a")}"></i><b id="${uid("a")}"></b>`,
		);
		const pages = new Pages({ root: "/tmp/unused" });
		Object.defineProperty(pages, "resolve", { value: async () => Page });

		const ctx = fakeContext();
		await renderPage(ctx.ctx, pages, "Page", {});

		expect(ctx.body()).toContain('id="a-1"');
		expect(ctx.body()).toContain('id="a-2"');
	});
});
