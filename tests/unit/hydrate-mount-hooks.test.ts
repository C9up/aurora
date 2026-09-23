import { beforeEach, describe, expect, it } from "vitest";
import {
	component,
	html,
	hydrate,
	onMount,
	renderToString,
	signal,
	type TemplateResult,
} from "../../src/index.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value === null || value === undefined)
		throw new Error("expected a value");
	return value;
}

/**
 * `onMount` for a component that appears AFTER hydration.
 *
 * Hydration collected mount hooks in one flat list and drained it once, at the
 * end. A reactive slot that swapped its content later kept appending to that
 * same list and nothing drained it again — so a component built when the data
 * arrived ran its setup and never its `onMount`.
 *
 * Reactive bindings still worked, which is what made it hard to see: the
 * symptom was a component whose whole job happens in `onMount` doing nothing
 * at all. A floating surface that only starts reacting once it is in the
 * document — tooltip, popover, dropdown — simply never appeared, while the
 * `aria-describedby` on its trigger toggled correctly.
 */
describe("aurora > hydrate > mount hooks after the first pass", () => {
	let container: HTMLElement;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
	});

	it("runs onMount for a component the initial pass already contained", () => {
		const mounted: string[] = [];
		const Child = component(() => {
			onMount(() => {
				mounted.push("child");
			});
			return html`<span>child</span>`;
		});
		const Page = component(() => html`<div>${Child()}</div>`);

		container.innerHTML = renderToString(Page());
		hydrate(container, Page);

		expect(mounted).toEqual(["child"]);
	});

	it("runs onMount for a component a slot renders once the data arrives", () => {
		const mounted: string[] = [];
		const rows = signal<string[]>([]);
		const Row = component((props: { label: string }) => {
			onMount(() => {
				mounted.push(props.label);
			});
			return html`<li>${props.label}</li>`;
		});
		const List = component(
			() => html`<ul>${() => rows().map((label) => Row({ label }))}</ul>`,
		);

		container.innerHTML = renderToString(List());
		hydrate(container, List);
		// Nothing yet: the list was empty when the server rendered it.
		expect(mounted).toEqual([]);

		rows(["a", "b"]);

		expect(mounted).toEqual(["a", "b"]);
		expect(defined(container.querySelector("ul")).children.length).toBe(2);
	});

	it("gives the hook a node that is already in the document", () => {
		// An `onMount` that measures, focuses or observes is the reason the
		// hooks run AFTER insertion rather than while the fragment is still
		// detached.
		const connected: boolean[] = [];
		const shown = signal(false);
		const Surface = component(() => {
			onMount(() => {
				connected.push(
					defined(document.querySelector("[data-surface]")).isConnected,
				);
			});
			return html`<div data-surface>surface</div>`;
		});
		const Page = component(
			() => html`<section>${() => (shown() ? Surface() : null)}</section>`,
		);

		container.innerHTML = renderToString(Page());
		hydrate(container, Page);
		shown(true);

		expect(connected).toEqual([true]);
	});

	it("runs onMount for a component reached through a children prop", () => {
		// Where a component actually sits: in the content of a badge, a cell or
		// a card, never alone at the top of a page.
		const mounted: string[] = [];
		const Child = component(() => {
			onMount(() => {
				mounted.push("child");
			});
			return html`<span>child</span>`;
		});
		const Box = component(
			(props: { children: unknown }) => html`<div>${props.children}</div>`,
		);
		const Page = component(
			() => html`<main>${Box({ children: Child() })}</main>`,
		);

		container.innerHTML = renderToString(Page());
		hydrate(container, Page);

		expect(mounted).toEqual(["child"]);
	});

	it("keeps BOTH lifecycles when a component returns another one's result", () => {
		// `const TextField = component((props) => Field({ ... }))` — a component
		// whose body is another component, which is how a compound set is built.
		// The lifecycle rides on the returned object, so the outer wrap used to
		// assign over the inner one: the inner component's setup ran, its
		// bindings worked, and its `onMount` never fired. A floating surface
		// reached through such a wrapper never opened, silently.
		const mounted: string[] = [];
		const Child = component(() => {
			onMount(() => {
				mounted.push("child");
			});
			return html`<span>child</span>`;
		});
		const Wrapper = component(() => {
			onMount(() => {
				mounted.push("wrapper");
			});
			return Child();
		});
		const Page = component(() => html`<main>${Wrapper()}</main>`);

		container.innerHTML = renderToString(Page());
		hydrate(container, Page);

		// Outer first, the order the renderer drains the queue in everywhere else.
		expect(mounted).toEqual(["wrapper", "child"]);
	});

	it("keeps the lifecycle of a children prop handed straight back", () => {
		const mounted: string[] = [];
		const Child = component(() => {
			onMount(() => {
				mounted.push("child");
			});
			return html`<span>child</span>`;
		});
		const Passthrough = component(
			(props: { children: TemplateResult }) => props.children,
		);
		const Page = component(
			() => html`<main>${Passthrough({ children: Child() })}</main>`,
		);

		container.innerHTML = renderToString(Page());
		hydrate(container, Page);

		expect(mounted).toEqual(["child"]);
	});

	it("tears the hook down when the slot replaces what it mounted", () => {
		// The teardown belongs to the slot, not to the page: a row's
		// subscription must end when the row goes, not when the tab closes.
		const events: string[] = [];
		const shown = signal(true);
		const Surface = component(() => {
			onMount(() => {
				events.push("mount");
				return () => events.push("teardown");
			});
			return html`<div>surface</div>`;
		});
		const Page = component(
			() => html`<section>${() => (shown() ? Surface() : null)}</section>`,
		);

		container.innerHTML = renderToString(Page());
		hydrate(container, Page);
		shown(false);
		shown(true);

		expect(events).toEqual(["mount", "teardown", "mount"]);
	});
});
