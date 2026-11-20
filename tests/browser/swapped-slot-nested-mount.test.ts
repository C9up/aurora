import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	component,
	html,
	hydrate,
	onMount,
	renderToString,
	signal,
	type TemplateResult,
} from "../../src/index.js";

/**
 * Real-Chromium check that a component two slots deep, swapped in after
 * hydration, measures a laid-out node in its `onMount`.
 *
 * The bug this pins: the swapped content was built in a detached fragment with
 * a queue already marked flushed, so the nested slot ran its component's
 * `onMount` before the fragment was inserted. A link graph opened from its tab
 * found no canvas and drew nothing; the same page loaded on that tab did.
 */
describe("aurora > browser > onMount two slots deep after a swap", () => {
	let host: HTMLElement;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
	});

	afterEach(() => {
		host.remove();
	});

	it("measures the canvas once the tab that holds it opens", () => {
		const widths: number[] = [];
		const Graph = component(() => {
			onMount(() => {
				const canvas = document.querySelector("[data-graph]");
				widths.push(canvas?.getBoundingClientRect().width ?? 0);
			});
			return html`<canvas data-graph style="width:240px;height:120px"></canvas>`;
		});
		const Card = (child: () => TemplateResult) =>
			html`<div class="card">${() => child()}</div>`;
		const view = signal<"list" | "graph">("list");
		const page = () =>
			html`<main>${() =>
				view() === "graph" ? Card(() => Graph()) : html`<p>list</p>`}</main>`;

		host.innerHTML = renderToString(page());
		hydrate(host, page);
		view("graph");

		expect(widths).toEqual([240]);
	});
});
