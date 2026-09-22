import { beforeEach, describe, expect, it } from "vitest";
import {
	component,
	html,
	hydrate,
	onMount,
	renderToString,
	signal,
} from "../../src/index.js";

/**
 * Real-Chromium check that `onMount` fires for a component that appears after
 * hydration, and that its node is live when it does.
 *
 * The unit suite covers the bookkeeping. This covers the reason the
 * bookkeeping matters: a hook that measures, positions or focuses needs a node
 * the browser has actually laid out, and a detached fragment in happy-dom
 * reports sizes a real one would not.
 *
 * The bug this pins: hydration drained its mount hooks once, so anything a
 * reactive slot built later ran its setup and never its `onMount`. A floating
 * surface whose whole job starts in `onMount` never appeared at all.
 */
describe("aurora > browser > mount hooks after hydration", () => {
	let container: HTMLElement;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
	});

	it("mounts a surface a slot reveals once the data arrives", () => {
		const boxes: Array<{ connected: boolean; width: number }> = [];
		const open = signal(false);
		const Surface = component(() => {
			onMount(() => {
				const node = document.querySelector("[data-surface]");
				if (node === null) throw new Error("the surface was never inserted");
				boxes.push({
					connected: node.isConnected,
					width: node.getBoundingClientRect().width,
				});
			});
			return html`<div data-surface style="width:120px">surface</div>`;
		});
		const Page = component(
			() => html`<section>${() => (open() ? Surface() : null)}</section>`,
		);

		container.innerHTML = renderToString(Page());
		hydrate(container, Page);
		expect(container.querySelector("[data-surface]")).toBeNull();

		open(true);

		expect(boxes).toHaveLength(1);
		expect(boxes[0]?.connected).toBe(true);
		// Laid out, not merely attached: a detached node measures zero, which
		// is what a positioning hook would silently act on.
		expect(boxes[0]?.width).toBeGreaterThan(0);
	});
});
