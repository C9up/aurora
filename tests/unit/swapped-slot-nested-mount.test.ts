/**
 * A component two slots deep, swapped in after the first render, mounts once
 * its nodes are in the document.
 *
 * A slot builds its new content in a detached fragment, then inserts it. The
 * queue it handed that content inherited `flushed = true` from the finished
 * root, so a slot NESTED in the new content believed the document already held
 * it: it ran its components' `onMount` straight away, while their nodes still
 * sat in the fragment. A hook that looked itself up with `querySelector` found
 * nothing, and one that measured read 0 — a link graph opened from its tab
 * never drew, while the same page loaded directly on that tab did.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	component,
	each,
	html,
	hydrate,
	onMount,
	render,
	renderToString,
	signal,
	type TemplateResult,
} from "../../src/index.js";

function probe() {
	const seen: Array<{ connected: boolean; found: boolean }> = [];
	const Probe = component(() => {
		onMount(() => {
			const node = document.querySelector("[data-probe]");
			seen.push({
				connected: node?.isConnected ?? false,
				found: node !== null,
			});
		});
		return html`<canvas data-probe></canvas>`;
	});
	// The component sits under a slot of its own, inside the swapped content:
	// the shape of a Card whose CardContent renders its children.
	const Card = (child: () => TemplateResult) =>
		html`<div class="card">${() => child()}</div>`;
	return { seen, panel: () => Card(() => Probe()) };
}

describe("onMount two slots deep, swapped in after the first render", () => {
	let host: HTMLElement;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
	});

	afterEach(() => {
		host.remove();
	});

	it("runs once the nodes are in the document (render)", () => {
		const { seen, panel } = probe();
		const view = signal<"list" | "graph">("list");
		render(
			html`<main>${() => (view() === "graph" ? panel() : html`<p>list</p>`)}</main>`,
			host,
		);
		expect(seen).toEqual([]);

		view("graph");

		expect(seen).toEqual([{ connected: true, found: true }]);
	});

	it("runs once the nodes are in the document (after hydration)", () => {
		const { seen, panel } = probe();
		const view = signal<"list" | "graph">("list");
		const page = () =>
			html`<main>${() => (view() === "graph" ? panel() : html`<p>list</p>`)}</main>`;
		host.innerHTML = renderToString(page());
		hydrate(host, page);
		expect(seen).toEqual([]);

		view("graph");

		expect(seen).toEqual([{ connected: true, found: true }]);
	});

	it("runs once the nodes are in the document (a row added to a list)", () => {
		const { seen, panel } = probe();
		const items = signal<readonly string[]>([]);
		render(
			html`<ul>${each(
				() => items(),
				(item) => item,
				() => html`<li>${panel()}</li>`,
			)}</ul>`,
			host,
		);

		items(["a"]);

		expect(seen).toEqual([{ connected: true, found: true }]);
	});

	it("still runs once, and tears down, when the slot swaps away", () => {
		const unmounted: string[] = [];
		const mounted: string[] = [];
		const Probe = component(() => {
			onMount(() => {
				mounted.push("probe");
				return () => unmounted.push("probe");
			});
			return html`<span></span>`;
		});
		const view = signal(false);
		render(
			html`<main>${() => (view() ? html`<div>${() => Probe()}</div>` : null)}</main>`,
			host,
		);

		view(true);
		expect(mounted).toEqual(["probe"]);
		view(false);
		expect(unmounted).toEqual(["probe"]);
	});
});
