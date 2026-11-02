/**
 * A reactive slot follows what its accessor reads, and nothing else.
 *
 * A component is built inside the accessor that shows it, and its setup ran
 * there tracked: every signal the setup read became a dependency of the slot,
 * as did every signal an `onMount` read when the slot ran the hooks of what it
 * had just swapped in. A component updating its own state rebuilt the whole
 * slot around it — often the page — and took with it whatever was open: a
 * tooltip, a menu, a half-typed field.
 */

import { describe, expect, it } from "vitest";
import {
	component,
	effect,
	html,
	hydrate,
	onMount,
	onUnmount,
	render,
	renderToString,
	signal,
} from "../../src/index.js";

/** A component that reads `source` in its setup, and shows it reactively. */
function readsInSetup(source: () => number) {
	return component(() => {
		const seen = source();
		return html`<b>${seen}</b><i>${() => source()}</i>`;
	});
}

/** A component that reads `source` when it mounts. */
function readsOnMount(source: () => number, seen: number[]) {
	return component(() => {
		onMount(() => {
			seen.push(source());
		});
		return html`<b>mounted</b>`;
	});
}

describe("a component does not subscribe the slot that shows it", () => {
	it("to what its setup reads", () => {
		const count = signal(0);
		const Child = readsInSetup(count);
		let builds = 0;
		const host = document.createElement("div");
		render(
			html`<main>${() => {
				builds++;
				return Child();
			}}</main>`,
			host,
		);
		count(1);
		count(2);
		expect(builds).toBe(1);
		// The component still follows its own state.
		expect(host.querySelector("i")?.textContent).toBe("2");
	});

	it("to what an onMount reads, in a slot that swapped it in later", () => {
		const count = signal(0);
		const shown = signal(false);
		const seen: number[] = [];
		const Child = readsOnMount(count, seen);
		let builds = 0;
		const host = document.createElement("div");
		render(
			html`<main>${() => {
				builds++;
				return shown() ? Child() : "";
			}}</main>`,
			host,
		);
		shown(true);
		expect(seen).toEqual([0]);
		count(1);
		count(2);
		expect(builds).toBe(2);
		expect(seen).toEqual([0]);
	});

	it("nor in a slot nested in another, swapped in after the first render", () => {
		const count = signal(0);
		const ready = signal(false);
		const seen: number[] = [];
		const Child = readsOnMount(count, seen);
		let outer = 0;
		let inner = 0;
		const host = document.createElement("div");
		render(
			html`<main>${() => {
				outer++;
				return html`<section>${() => {
					inner++;
					return ready() ? Child() : "";
				}}</section>`;
			}}</main>`,
			host,
		);
		ready(true);
		expect(seen).toEqual([0]);
		count(1);
		expect([outer, inner]).toEqual([1, 2]);
	});
});

describe("after hydration", () => {
	it("the setup of a component a slot swapped in subscribes nothing", () => {
		const count = signal(0);
		const page = signal("a");
		const Child = readsInSetup(count);
		let builds = 0;
		const view = () =>
			html`<main>${() => {
				builds++;
				return page() === "a" ? html`<p>a</p>` : Child();
			}}</main>`;
		const host = document.createElement("div");
		host.innerHTML = renderToString(view());
		builds = 0;
		hydrate(host, view);
		page("b");
		count(1);
		expect(builds).toBe(2);
		expect(host.querySelector("i")?.textContent).toBe("1");
	});

	it("nor its onMount", () => {
		const count = signal(0);
		const page = signal("a");
		const seen: number[] = [];
		const Child = readsOnMount(count, seen);
		let builds = 0;
		const view = () =>
			html`<main>${() => {
				builds++;
				return page() === "a" ? html`<p>a</p>` : Child();
			}}</main>`;
		const host = document.createElement("div");
		host.innerHTML = renderToString(view());
		builds = 0;
		hydrate(host, view);
		page("b");
		count(1);
		expect(builds).toBe(2);
		expect(seen).toEqual([0]);
	});

	it("nor the setup of a component it adopted from the server", () => {
		const count = signal(0);
		const Child = readsInSetup(count);
		let builds = 0;
		const view = () =>
			html`<main>${() => {
				builds++;
				return Child();
			}}</main>`;
		const host = document.createElement("div");
		host.innerHTML = renderToString(view());
		builds = 0;
		hydrate(host, view);
		count(1);
		expect(builds).toBe(1);
		expect(host.querySelector("i")?.textContent).toBe("1");
	});
});

describe("a root rendered from an effect", () => {
	it("does not subscribe that effect to what it builds", () => {
		// What an overlay does: it renders its content into a portal from the
		// effect that follows its open state.
		const open = signal(true);
		const count = signal(0);
		const seen: number[] = [];
		const Child = readsOnMount(count, seen);
		const InSetup = readsInSetup(count);
		let runs = 0;
		const host = document.createElement("div");
		let dispose = (): void => {};
		effect(() => {
			runs++;
			dispose();
			dispose = open() ? render(html`${Child()}${InSetup()}`, host) : () => {};
		});
		count(1);
		expect(runs).toBe(1);
		expect(seen).toEqual([0]);
		open(false);
		expect(runs).toBe(2);
	});

	it("nor when it is disposed, by an onUnmount or an onMount's teardown", () => {
		// The overlay disposes its content at the start of the effect's next run,
		// so what the teardowns read is read inside that run.
		for (const teardown of ["onUnmount", "onMount"] as const) {
			const open = signal(true);
			const count = signal(0);
			const Child = component(() => {
				if (teardown === "onUnmount") onUnmount(() => count());
				else onMount(() => () => count());
				return html`<b>child</b>`;
			});
			let runs = 0;
			const host = document.createElement("div");
			let dispose = (): void => {};
			effect(() => {
				runs++;
				dispose();
				dispose = open() ? render(html`${Child()}`, host) : () => {};
			});
			open(false);
			count(1);
			expect({ teardown, runs }).toEqual({ teardown, runs: 2 });
		}
	});

	it("nor when a root hydrated from an effect is disposed", () => {
		for (const teardown of ["onUnmount", "onMount"] as const) {
			const open = signal(true);
			const count = signal(0);
			const Child = component(() => {
				if (teardown === "onUnmount") onUnmount(() => count());
				else onMount(() => () => count());
				return html`<b>child</b>`;
			});
			const view = () => html`<main>${Child()}</main>`;
			const host = document.createElement("div");
			host.innerHTML = renderToString(view());
			let runs = 0;
			let dispose = (): void => {};
			effect(() => {
				runs++;
				dispose();
				dispose = open() ? hydrate(host, view) : () => {};
			});
			open(false);
			count(1);
			expect({ teardown, runs }).toEqual({ teardown, runs: 2 });
		}
	});

	it("nor does one hydrated from an effect", () => {
		const count = signal(0);
		const seen: number[] = [];
		const Child = readsOnMount(count, seen);
		const view = () => html`<main>${Child()}</main>`;
		const host = document.createElement("div");
		host.innerHTML = renderToString(view());
		let runs = 0;
		effect(() => {
			runs++;
			if (runs === 1) hydrate(host, view);
		});
		count(1);
		expect(runs).toBe(1);
		expect(seen).toEqual([0]);
	});
});
