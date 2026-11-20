/**
 * The renderer touches the DOM only when what it shows changed.
 *
 * A slot rebuilt its nodes, and a binding rewrote its attribute or property,
 * every time its effect re-ran — and an effect re-runs whenever anything it
 * read changed, not only when its result did. A list polled every few seconds
 * replaced the text of every row on every poll; a `.value` binding re-run by
 * an unrelated signal put back the value the user had typed over; hydration
 * rewrote every reactive attribute the server had already written.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	component,
	each,
	effect,
	html,
	hydrate,
	onMount,
	render,
	renderToString,
	signal,
} from "../../src/index.js";

/** Every mutation under `root` from now on, read synchronously. */
function watch(root: Node): () => MutationRecord[] {
	const observer = new MutationObserver(() => {});
	observer.observe(root, {
		subtree: true,
		childList: true,
		attributes: true,
		characterData: true,
	});
	const seen: MutationRecord[] = [];
	return () => {
		seen.push(...observer.takeRecords());
		return seen;
	};
}

let host: HTMLElement;
afterEach(() => {
	host?.remove();
});

function mountHost(): HTMLElement {
	host = document.createElement("div");
	document.body.append(host);
	return host;
}

describe("a text slot", () => {
	it("leaves its node alone when the accessor recomputes the same text", () => {
		const n = signal(1);
		const root = mountHost();
		render(html`<p>${() => (n() > 5 ? "big" : "small")}</p>`, root);
		const before = root.querySelector("p")?.firstChild;
		const mutations = watch(root);
		n(2);
		n(3);
		expect(mutations()).toEqual([]);
		expect(root.querySelector("p")?.firstChild).toBe(before);
	});

	it("updates its text node in place when the text changes", () => {
		const label = signal("a");
		const root = mountHost();
		render(html`<p>${label}</p>`, root);
		const before = root.querySelector("p")?.firstChild;
		label("b");
		expect(root.querySelector("p")?.textContent).toBe("b");
		expect(root.querySelector("p")?.firstChild).toBe(before);
	});

	it("keeps a template that renders exactly as the one it shows", () => {
		const user = signal({ name: "Ada", role: "admin" });
		const root = mountHost();
		render(
			html`<div>${() => html`<b class="${user().role}">${user().name}</b>`}</div>`,
			root,
		);
		const before = root.querySelector("b");
		const mutations = watch(root);
		// A re-fetch: a new object, the same content.
		user({ name: "Ada", role: "admin" });
		expect(mutations()).toEqual([]);
		expect(root.querySelector("b")).toBe(before);
		user({ name: "Grace", role: "admin" });
		expect(root.querySelector("b")?.textContent).toBe("Grace");
	});

	it("after hydration, leaves its node alone when the accessor recomputes the same text", () => {
		const n = signal(1);
		const view = () => html`<p>${() => (n() > 5 ? "big" : "small")}</p>`;
		const root = mountHost();
		root.innerHTML = renderToString(view());
		hydrate(root, view);
		const mutations = watch(root);
		n(2);
		expect(mutations()).toEqual([]);
		n(9);
		expect(root.textContent).toBe("big");
	});
});

describe("an attribute binding", () => {
	it("does not rewrite an attribute whose value did not change", () => {
		const n = signal(1);
		const root = mountHost();
		render(html`<p class=${() => (n() % 2 ? "odd" : "even")}></p>`, root);
		const mutations = watch(root);
		n(3);
		n(5);
		expect(mutations()).toEqual([]);
		n(6);
		expect(root.querySelector("p")?.className).toBe("even");
	});

	it("does not rewrite a multi-part attribute whose value did not change", () => {
		const n = signal(1);
		const root = mountHost();
		render(html`<p class="row ${() => (n() > 0 ? "on" : "off")}"></p>`, root);
		const mutations = watch(root);
		n(2);
		expect(mutations()).toEqual([]);
	});

	it("does not re-set a boolean attribute that did not change", () => {
		const n = signal(1);
		const root = mountHost();
		render(html`<button ?disabled=${() => n() > 0}></button>`, root);
		const mutations = watch(root);
		n(2);
		expect(mutations()).toEqual([]);
	});

	it("does not rewrite reactive attributes the server already wrote when it hydrates", () => {
		const open = signal(true);
		const view = () =>
			html`<div class=${() => (open() ? "open" : "closed")} ?hidden=${() => !open()} data-x="a ${() => (open() ? "1" : "0")}"></div>`;
		const root = mountHost();
		root.innerHTML = renderToString(view());
		const mutations = watch(root);
		hydrate(root, view);
		expect(mutations()).toEqual([]);
	});
});

describe("a property binding", () => {
	it("does not put back the value the user typed over when an unrelated signal re-runs it", () => {
		const name = signal("Ada");
		const theme = signal("light");
		const root = mountHost();
		render(
			html`<input .value=${() => {
				theme();
				return name();
			}} />`,
			root,
		);
		const input = root.querySelector("input");
		if (input === null) throw new Error("no input");
		input.value = "Ad";
		theme("dark");
		expect(input.value).toBe("Ad");
		name("Grace");
		expect(input.value).toBe("Grace");
	});
});

describe("a keyed list", () => {
	it("leaves its rows' nodes alone when a poll brings equal elements", () => {
		const rows = signal([
			{ id: 1, name: "a", done: false },
			{ id: 2, name: "b", done: true },
		]);
		const root = mountHost();
		render(
			html`<ul>${each(
				rows,
				(r) => r.id,
				(row) =>
					html`<li class=${() => (row().done ? "done" : "")}>${() => row().name}</li>`,
			)}</ul>`,
			root,
		);
		const mutations = watch(root);
		rows([
			{ id: 1, name: "a", done: false },
			{ id: 2, name: "b", done: true },
		]);
		expect(mutations()).toEqual([]);
	});

	it("runs a row that reads the list once when an element is removed, and never the removed one", () => {
		const items = signal(["a", "b", "c"]);
		const runs: string[] = [];
		const root = mountHost();
		render(
			html`<ul>${each(
				items,
				(x) => x,
				(item, index) =>
					html`<li>${() => {
						runs.push(item());
						return `${index() + 1}/${items().length}`;
					}}</li>`,
			)}</ul>`,
			root,
		);
		runs.length = 0;
		items(["b", "c"]);
		expect(runs.sort()).toEqual(["b", "c"]);
		expect(root.textContent).toBe("1/22/2");
	});
});

describe("what a component creates outside its setup", () => {
	it("an effect created in onMount ends when the component unmounts", () => {
		const source = signal(0);
		let runs = 0;
		const Probe = component(() => {
			onMount(() => {
				effect(() => {
					source();
					runs++;
				});
			});
			return html`<i></i>`;
		});
		const root = mountHost();
		const dispose = render(Probe(), root);
		dispose();
		runs = 0;
		source(1);
		expect(runs).toBe(0);
	});

	it("an effect created in the onMount of a component a slot swapped in ends when the slot swaps it out", () => {
		const source = signal(0);
		const show = signal(false);
		let runs = 0;
		const Probe = component(() => {
			onMount(() => {
				effect(() => {
					source();
					runs++;
				});
			});
			return html`<i></i>`;
		});
		const root = mountHost();
		render(html`<div>${() => (show() ? Probe() : null)}</div>`, root);
		show(true);
		show(false);
		runs = 0;
		source(1);
		expect(runs).toBe(0);
	});

	it("a root rendered from an effect keeps its bindings when that effect runs again", () => {
		// An overlay keeps its content mounted across re-runs of the effect that
		// follows its state: the root is its own, ended only by its disposer.
		const open = signal(true);
		const placement = signal("top");
		const label = signal("a");
		const portal = mountHost();
		let mounted: (() => void) | undefined;
		effect(() => {
			placement();
			if (open() && mounted === undefined) {
				mounted = render(html`<p>${label}</p>`, portal);
			}
		});
		placement("bottom");
		label("b");
		expect(portal.textContent).toBe("b");
		mounted?.();
	});
});
