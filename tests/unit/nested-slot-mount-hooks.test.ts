/**
 * A component built by a NESTED reactive slot, after the first render, mounts.
 *
 * A slot hands the slots inside its content its own queue of `onMount` hooks,
 * and the root runs that queue once, when the tree is first in place. The
 * queue stayed marked "not flushed yet", so when an inner slot swapped its
 * content later it queued the new component's hooks there, behind a flush that
 * had already happened: the component's setup ran and its `onMount` never did,
 * nor the teardown it returns. One level of slot was enough to hide it, since
 * the root's own queue was the only one ever marked.
 */

import { describe, expect, it } from "vitest";
import {
	component,
	html,
	hydrate,
	onMount,
	render,
	renderToString,
	signal,
} from "../../src/index.js";

function tracked() {
	const mounted: string[] = [];
	const unmounted: string[] = [];
	const Row = component((props: { name: string }) => {
		onMount(() => {
			mounted.push(props.name);
			return () => unmounted.push(props.name);
		});
		return html`<li>${props.name}</li>`;
	});
	return { mounted, unmounted, Row };
}

describe("onMount under a nested reactive slot", () => {
	it("runs for a row added after the first render, and tears down when it goes", () => {
		const { mounted, unmounted, Row } = tracked();
		const rows = signal<readonly string[]>(["a"]);
		const view = html`<section>${html`<ul>${() => rows().map((name) => Row({ name }))}</ul>`}</section>`;
		render(view, document.createElement("div"));
		expect(mounted).toEqual(["a"]);

		rows(["a", "b"]);
		expect(mounted).toEqual(["a", "a", "b"]);
		expect(unmounted).toEqual(["a"]);

		rows([]);
		expect(unmounted).toEqual(["a", "a", "b"]);
	});

	it("runs after hydration too, under a reactive slot inside a reactive slot", () => {
		const { mounted, unmounted, Row } = tracked();
		const rows = signal<readonly string[]>(["a"]);
		const open = signal(true);
		const view = () =>
			html`<section>${() =>
				open()
					? html`<ul>${() => rows().map((name) => Row({ name }))}</ul>`
					: null}</section>`;
		const host = document.createElement("div");
		host.innerHTML = renderToString(view());
		hydrate(host, view);
		expect(mounted).toEqual(["a"]);

		rows(["a", "b"]);
		expect(mounted).toEqual(["a", "a", "b"]);
		expect(unmounted).toEqual(["a"]);
	});
});
