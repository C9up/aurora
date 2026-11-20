/**
 * The development re-render counter hears every re-run the runtime makes, and
 * nothing once it is stopped.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	component,
	countRerenders,
	effect,
	html,
	memo,
	type RerenderCounter,
	type RerenderEvent,
	render,
	signal,
} from "../../src/index.js";
import { probe } from "../../src/rerenders.js";

let counter: RerenderCounter | undefined;
afterEach(() => {
	counter?.stop();
	counter = undefined;
});

describe("countRerenders", () => {
	it("counts effect and memo re-runs, not their first run", () => {
		counter = countRerenders();
		const n = signal(1);
		const double = memo(() => n() * 2);
		effect(() => {
			double();
		});
		expect(counter.counts().effect).toBe(0);
		n(2);
		expect(counter.counts()).toMatchObject({ effect: 1, memo: 1 });
	});

	it("counts a slot that rebuilt, an attribute rewritten, and names the element", () => {
		counter = countRerenders();
		const n = signal(1);
		const host = document.createElement("div");
		render(
			html`<p class=${() => (n() > 1 ? "big" : "small")}>${() => (n() > 2 ? "x" : "y")}</p>`,
			host,
		);
		n(2);
		n(3);
		expect(counter.counts()).toMatchObject({ attribute: 1, slot: 1 });
		const p = host.querySelector("p");
		expect(counter.top(1)).toEqual([{ target: p, count: 2 }]);
	});

	it("does not count a slot whose value rendered the same", () => {
		counter = countRerenders();
		const n = signal(1);
		render(
			html`<p>${() => (n() > 5 ? "big" : "small")}</p>`,
			document.createElement("div"),
		);
		n(2);
		expect(counter.counts().slot).toBe(0);
		expect(counter.counts().effect).toBe(1);
	});

	it("counts setups by name, and points a slot that rebuilt an array to each()", () => {
		const events: RerenderEvent[] = [];
		counter = countRerenders({ onRerender: (e) => events.push(e) });
		const rows = signal(["a"]);
		const Row = component(function ListRow(props: { label: string }) {
			return html`<li>${props.label}</li>`;
		});
		render(
			html`<ul>${() => rows().map((label) => Row({ label }))}</ul>`,
			document.createElement("div"),
		);
		rows(["a", "b"]);
		expect(counter.setups()).toEqual([{ name: "ListRow", count: 3 }]);
		const slot = events.find((e) => e.kind === "slot");
		expect(slot?.hint).toMatch(/each\(/);
	});

	it("outlines an element that re-rendered, and restores it when stopped", () => {
		counter = countRerenders({ highlight: true });
		const n = signal(1);
		const host = document.createElement("div");
		render(html`<p style="outline: none">${n}</p>`, host);
		n(2);
		const p = host.querySelector("p");
		expect(p?.style.outline).not.toBe("none");
		counter.stop();
		expect(p?.style.outline).toBe("none");
	});

	it("reports nothing once every counter is stopped", () => {
		const first = countRerenders();
		const second = countRerenders();
		first.stop();
		expect(probe.emit).toBeDefined();
		second.stop();
		expect(probe.emit).toBeUndefined();
	});

	it("starts over on reset", () => {
		counter = countRerenders();
		const n = signal(1);
		effect(() => {
			n();
		});
		n(2);
		counter.reset();
		expect(counter.counts().effect).toBe(0);
		expect(counter.top()).toEqual([]);
	});
});
