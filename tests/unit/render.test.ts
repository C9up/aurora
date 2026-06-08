import { beforeEach, describe, expect, it } from "vitest";
import { html, render, signal } from "../../src/index.js";

let container: HTMLElement;

beforeEach(() => {
	container = document.createElement("div");
});

describe("aurora > render > static", () => {
	it("renders a primitive into a text slot", () => {
		render(html`<p>${"hello"}</p>`, container);
		expect(container.innerHTML).toContain("hello");
	});

	it("renders numbers, joining static + dynamic parts", () => {
		render(html`<p>count: ${42}</p>`, container);
		expect(container.textContent?.trim()).toBe("count: 42");
	});

	it("skips null / undefined / false (no text node emitted)", () => {
		render(html`<p>a${null}b${undefined}c${false}d</p>`, container);
		expect(container.textContent).toBe("abcd");
	});

	it("renders an array as a sequence of children", () => {
		render(html`<ul>${[1, 2, 3]}</ul>`, container);
		expect(container.textContent).toBe("123");
	});

	it("renders nested TemplateResults", () => {
		const inner = html`<em>${"x"}</em>`;
		render(html`<div>${inner}</div>`, container);
		expect(container.querySelector("em")?.textContent).toBe("x");
	});
});

describe("aurora > render > reactive text", () => {
	it("re-renders when a signal in a text slot changes", () => {
		const count = signal(0);
		render(html`<p>${count}</p>`, container);
		expect(container.textContent?.trim()).toBe("0");
		count(1);
		expect(container.textContent?.trim()).toBe("1");
		count(99);
		expect(container.textContent?.trim()).toBe("99");
	});

	it("re-renders when a function-as-expression reads a signal", () => {
		const count = signal(2);
		render(html`<p>${() => count() * 2}</p>`, container);
		expect(container.textContent?.trim()).toBe("4");
		count(10);
		expect(container.textContent?.trim()).toBe("20");
	});

	it("dispose stops the effect (no further DOM updates) and removes the nodes", () => {
		const count = signal(0);
		const dispose = render(html`<p>${count}</p>`, container);
		dispose();
		count(1);
		// Nodes are removed AND the effect no longer touches the DOM.
		expect(container.innerHTML).toBe("");
	});

	it("disposes the OLD subtree's effects when a reactive slot swaps nested templates", () => {
		// Branch selector + a signal read INSIDE branch A. Swapping the
		// branch away must dispose branch A's inner effect — otherwise a
		// later mutation of `aVal` keeps re-running a subscription bound
		// to detached nodes (the leak this test guards).
		const which = signal<"a" | "b">("a");
		const aVal = signal(0);
		let aRuns = 0;

		render(
			html`<div>${() =>
				which() === "a"
					? html`<span>${() => {
							aRuns += 1;
							return aVal();
						}}</span>`
					: html`<b>other</b>`}</div>`,
			container,
		);

		expect(aRuns).toBe(1);
		expect(container.textContent).toContain("0");

		// Branch A is live: mutating aVal re-runs its effect.
		aVal(5);
		expect(aRuns).toBe(2);
		expect(container.textContent).toContain("5");

		// Swap to branch B — branch A's nodes leave the DOM and its inner
		// effect must be disposed.
		which("b");
		expect(container.textContent).toContain("other");
		const runsAfterSwap = aRuns;

		// Mutating aVal now must NOT re-run the disposed branch-A effect.
		aVal(9);
		aVal(13);
		expect(aRuns).toBe(runsAfterSwap);
	});

	it("does not accumulate stale effects across many swaps", () => {
		const which = signal(0);
		const tick = signal(0);
		let totalRuns = 0;

		render(
			html`<div>${() => {
				// New branch identity each toggle so each render mounts a
				// fresh nested template with its own inner effect.
				const n = which();
				return html`<span>${() => {
					totalRuns += 1;
					return `${n}:${tick()}`;
				}}</span>`;
			}}</div>`,
			container,
		);

		// Toggle the branch 10 times, then mutate `tick` once. If old
		// subtree effects leaked, all 10 stale effects would re-run on the
		// single `tick` change. With per-render disposal only the CURRENT
		// branch's effect re-runs.
		for (let i = 1; i <= 10; i += 1) which(i);
		const runsBeforeTick = totalRuns;
		tick(1);
		// Exactly ONE additional run (the live branch), not 11.
		expect(totalRuns).toBe(runsBeforeTick + 1);
	});
});

describe("aurora > render > attributes", () => {
	it("sets a static attribute from a primitive", () => {
		render(html`<a href="${"https://x.test"}">x</a>`, container);
		expect(container.querySelector("a")?.getAttribute("href")).toBe(
			"https://x.test",
		);
	});

	it("removes an attribute when value is null / undefined / false", () => {
		render(html`<a href="${null}">x</a>`, container);
		expect(container.querySelector("a")?.hasAttribute("href")).toBe(false);
	});

	it("emits `true` as an empty-value attribute", () => {
		render(html`<input data-checked="${true}" />`, container);
		expect(container.querySelector("input")?.getAttribute("data-checked")).toBe(
			"",
		);
	});

	it("tracks signal changes on an attribute", () => {
		const cls = signal("on");
		render(html`<span class="${cls}">x</span>`, container);
		expect(container.querySelector("span")?.getAttribute("class")).toBe("on");
		cls("off");
		expect(container.querySelector("span")?.getAttribute("class")).toBe("off");
	});

	it("joins multi-slot attrs with static parts", () => {
		const a = signal("foo");
		const b = signal("bar");
		render(html`<div class="prefix ${a} mid ${b} suffix">x</div>`, container);
		expect(container.querySelector("div")?.getAttribute("class")).toBe(
			"prefix foo mid bar suffix",
		);
		a("FOO");
		b("BAR");
		expect(container.querySelector("div")?.getAttribute("class")).toBe(
			"prefix FOO mid BAR suffix",
		);
	});
});

describe("aurora > render > boolean / prop", () => {
	it("toggles a boolean attribute with ?attr", () => {
		const disabled = signal(true);
		render(html`<button ?disabled="${disabled}">x</button>`, container);
		const btn = container.querySelector("button");
		expect(btn?.hasAttribute("disabled")).toBe(true);
		disabled(false);
		expect(btn?.hasAttribute("disabled")).toBe(false);
	});

	it("assigns a DOM property with .prop", () => {
		const value = signal("hello");
		render(html`<input .value="${value}" />`, container);
		const input = container.querySelector("input") as HTMLInputElement;
		expect(input.value).toBe("hello");
		value("world");
		expect(input.value).toBe("world");
	});
});

describe("aurora > render > events", () => {
	it("calls the @event handler on dispatch", () => {
		let clicks = 0;
		const onClick = () => clicks++;
		render(html`<button @click="${onClick}">x</button>`, container);
		const btn = container.querySelector("button") as HTMLButtonElement;
		btn.click();
		btn.click();
		expect(clicks).toBe(2);
	});

	it("removes the listener on dispose", () => {
		let clicks = 0;
		const onClick = () => clicks++;
		const dispose = render(
			html`<button @click="${onClick}">x</button>`,
			container,
		);
		const btn = container.querySelector("button") as HTMLButtonElement;
		btn.click();
		dispose();
		expect(clicks).toBe(1);
	});

	it("a button that mutates a signal in its handler updates other bindings", () => {
		const count = signal(0);
		render(
			html`<div>
				<button @click="${() => count(count() + 1)}">+</button>
				<output>${count}</output>
			</div>`,
			container,
		);
		const btn = container.querySelector("button") as HTMLButtonElement;
		const out = container.querySelector("output") as HTMLOutputElement;
		expect(out.textContent?.trim()).toBe("0");
		btn.click();
		btn.click();
		expect(out.textContent?.trim()).toBe("2");
	});
});
