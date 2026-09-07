/**
 * A component built by a LATER reactive update must mount.
 *
 * `onMount` hooks are collected into one queue while the tree is built and
 * flushed once, after the fragment is in the document. A reactive slot that
 * swaps its content afterwards kept appending to that same queue — which
 * nobody flushes again. The component's setup ran, its `onMount` never did,
 * and nothing was logged.
 *
 * This is the whole floating layer in a table: rows arrive from an RPC, so
 * every menu built from them is a later update. Each one toggled its state and
 * never opened a panel.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { component, html, onMount, render, signal } from "../../src/index.js";

let container: HTMLElement;
beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});
afterEach(() => container.remove());

describe("aurora > lifecycle inside a reactive slot", () => {
	it("runs onMount for a component that appears on a later update", async () => {
		const mounted: string[] = [];
		const Row = component<{ name: string }>((props) => {
			onMount(() => {
				mounted.push(props.name);
			});
			return html`<li>${props.name}</li>`;
		});

		const rows = signal<string[]>([]);
		render(
			html`<ul>${() => rows().map((name) => Row({ name }))}</ul>`,
			container,
		);

		// Nothing yet, and nothing to mount.
		expect(mounted).toEqual([]);

		// The rows arrive, as they would from an RPC.
		rows(["a", "b"]);
		await Promise.resolve();

		expect(container.querySelectorAll("li")).toHaveLength(2);
		expect(mounted).toEqual(["a", "b"]);
	});

	it("sees the node in the document, not a detached fragment", async () => {
		// An onMount that measures, focuses or observes is worthless if it runs
		// before the node is live — which is why the root flush happens after the
		// fragment is appended.
		let connected: boolean | undefined;
		const Probe = component(() => {
			onMount(() => {
				connected = document.body.contains(document.querySelector("#probe"));
			});
			return html`<span id="probe">x</span>`;
		});

		const show = signal(false);
		render(html`<div>${() => (show() ? Probe({}) : null)}</div>`, container);
		show(true);
		await Promise.resolve();

		expect(connected).toBe(true);
	});

	it("runs the cleanup when the slot swaps that content away", async () => {
		const events: string[] = [];
		const Ephemeral = component(() => {
			onMount(() => {
				events.push("mount");
				return () => events.push("cleanup");
			});
			return html`<span>e</span>`;
		});

		const show = signal(true);
		render(
			html`<div>${() => (show() ? Ephemeral({}) : null)}</div>`,
			container,
		);
		await Promise.resolve();
		expect(events).toEqual(["mount"]);

		show(false);
		await Promise.resolve();

		// Without this the teardown sits on the ROOT's cleanup list and only runs
		// when the whole page unmounts — a subscription per row, forever.
		expect(events).toEqual(["mount", "cleanup"]);
	});

	it("still mounts a component present on the FIRST render", async () => {
		// The regression guard: the initial pass must keep flushing after the
		// fragment is appended, not while it is still detached.
		const seen: string[] = [];
		const First = component(() => {
			onMount(() => {
				seen.push("first");
			});
			return html`<span>1</span>`;
		});

		render(html`<div>${First({})}</div>`, container);
		await Promise.resolve();

		expect(seen).toEqual(["first"]);
	});
});
