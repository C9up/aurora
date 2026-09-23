/**
 * Ids that survive hydration.
 *
 * An id is minted from a counter, so the server and the browser agree only if
 * both passes start from the same place. A server process is long-lived: with
 * no reset its counter climbs across requests, and the second page it serves
 * ships `trigger-14` while the browser, starting fresh, looks up `trigger-1`.
 *
 * What makes it nasty is that every id-based lookup then answers `null`
 * SILENTLY. Nothing throws; a tooltip simply never opens, an anchor never
 * positions, an `aria-controls` points at nothing — on a page where every
 * binding otherwise works.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	byId,
	component,
	html,
	hydrate,
	onMount,
	renderToString,
	resetIds,
	uid,
} from "../../src/index.js";

describe("aurora > uid", () => {
	beforeEach(() => {
		resetIds();
	});

	it("mints a unique id per call and takes a prefix", () => {
		expect(uid("trigger")).toBe("trigger-1");
		expect(uid("trigger")).toBe("trigger-2");
		expect(uid()).toBe("aurora-3");
	});

	it("restarts the sequence on reset", () => {
		uid();
		uid();
		resetIds();
		expect(uid("x")).toBe("x-1");
	});

	it("answers null off the DOM rather than throwing", () => {
		expect(byId("nothing-here")).toBeNull();
	});
});

describe("aurora > ids across a render pass", () => {
	let container: HTMLElement;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
	});

	it("finds the server's node from the browser's id", () => {
		// The real shape of the bug: a component mints an id, puts it in the
		// markup, and looks the node up in `onMount`. The lookup only works if
		// the id the browser minted is the one the server wrote.
		const found: Array<HTMLElement | null> = [];
		const Anchored = component(() => {
			const id = uid("trigger");
			onMount(() => {
				found.push(byId(id));
			});
			return html`<span id="${id}">?</span>`;
		});
		const Page = component(() => html`<div>${Anchored()}</div>`);

		// A server that already served other pages: its counter is not at zero.
		uid();
		uid();
		uid();
		resetIds();
		container.innerHTML = renderToString(Page());
		// …and more work between the two passes, as a real process would have.
		uid();
		uid();

		hydrate(container, Page);

		expect(found).toHaveLength(1);
		// `hydrate` restarted the sequence, so the id matches the markup.
		expect(found[0]).not.toBeNull();
		expect(found[0]?.id).toBe("trigger-1");
	});
});
