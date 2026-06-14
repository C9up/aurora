import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	component,
	effect,
	html,
	memo,
	onMount,
	onUnmount,
	render,
	signal,
} from "../../src/index.js";
import { observerCount } from "../../src/reactive.js";

let container: HTMLElement;

beforeEach(() => {
	container = document.createElement("div");
});

describe("aurora > component > setup", () => {
	it("runs setup once and renders the resulting template", () => {
		const setup = vi.fn(() => html`<p>hi</p>`);
		const C = component(setup);
		render(C(), container);
		expect(setup).toHaveBeenCalledTimes(1);
		expect(container.textContent).toBe("hi");
	});

	it("forwards props to setup", () => {
		const C = component<{ name: string }>(({ name }) => html`<p>${name}</p>`);
		render(C({ name: "Hugo" }), container);
		expect(container.textContent).toBe("Hugo");
	});

	it("defaults to {} when called without props", () => {
		const C = component<{ name?: string }>(
			({ name = "stranger" }) => html`<p>${name}</p>`,
		);
		render(C(), container);
		expect(container.textContent).toBe("stranger");
	});
});

describe("aurora > component > state via signal()", () => {
	it("signal updates from within a component propagate to the DOM", () => {
		const C = component(() => {
			const count = signal(0);
			return html`<button @click="${() => count(count() + 1)}">${count}</button>`;
		});
		render(C(), container);
		const btn = container.querySelector("button") as HTMLButtonElement;
		expect(btn.textContent?.trim()).toBe("0");
		btn.click();
		btn.click();
		expect(btn.textContent?.trim()).toBe("2");
	});

	it("each component instance has its own state", () => {
		const Counter = component(() => {
			const c = signal(0);
			return html`<span @click="${() => c(c() + 1)}">${c}</span>`;
		});
		render(html`${Counter()}${Counter()}`, container);
		const spans = container.querySelectorAll("span");
		expect(spans).toHaveLength(2);
		(spans[0] as HTMLElement).click();
		expect(spans[0].textContent?.trim()).toBe("1");
		expect(spans[1].textContent?.trim()).toBe("0");
	});
});

describe("aurora > component > memo()", () => {
	it("memo derives reactively from upstream state", () => {
		const C = component(() => {
			const n = signal(2);
			const doubled = memo(() => n() * 2);
			return html`<output @click="${() => n(n() + 1)}">${doubled}</output>`;
		});
		render(C(), container);
		const out = container.querySelector("output") as HTMLElement;
		expect(out.textContent?.trim()).toBe("4");
		out.click();
		expect(out.textContent?.trim()).toBe("6");
	});
});

describe("aurora > component > lifecycle", () => {
	it("onMount runs after the fragment is in the document", () => {
		const seen: string[] = [];
		const C = component(() => {
			onMount(() => {
				seen.push("mounted");
			});
			return html`<p>x</p>`;
		});
		render(C(), container);
		expect(seen).toEqual(["mounted"]);
	});

	it("onMount cleanup + onUnmount fire on dispose", () => {
		const seen: string[] = [];
		const C = component(() => {
			onMount(() => {
				seen.push("mount");
				return () => seen.push("mount-cleanup");
			});
			onUnmount(() => seen.push("unmount"));
			return html`<p>x</p>`;
		});
		const dispose = render(C(), container);
		expect(seen).toEqual(["mount"]);
		dispose();
		expect(seen).toContain("mount-cleanup");
		expect(seen).toContain("unmount");
	});

	it("effect() cleanup tied to a component runs on unmount via onUnmount", () => {
		const cleanup = vi.fn();
		const C = component(() => {
			const n = signal(0);
			const dispose = effect(() => {
				n(); // track
			});
			onUnmount(() => {
				dispose();
				cleanup();
			});
			return html`<p>${n}</p>`;
		});
		const dispose = render(C(), container);
		expect(cleanup).toHaveBeenCalledTimes(0);
		dispose();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it("disposes a memo created in setup when the component unmounts (no leak)", () => {
		const src = signal(1);
		const C = component(() => {
			const doubled = memo(() => src() * 2);
			return html`<p>${doubled}</p>`;
		});
		const dispose = render(C(), container);
		expect(observerCount(src)).toBeGreaterThan(0);
		dispose();
		// The memo's recompute effect must detach from `src` at unmount — its
		// disposer was discarded before the owner fix, leaking subscriptions.
		expect(observerCount(src)).toBe(0);
	});

	it("disposes an effect created in setup when the component unmounts", () => {
		const src = signal(0);
		const C = component(() => {
			effect(() => {
				src(); // track
			});
			return html`<p>x</p>`;
		});
		const dispose = render(C(), container);
		expect(observerCount(src)).toBeGreaterThan(0);
		dispose();
		expect(observerCount(src)).toBe(0);
	});

	it("onMount called outside a component throws a clear error", () => {
		expect(() => onMount(() => {})).toThrow(/outside component/);
		expect(() => onUnmount(() => {})).toThrow(/outside component/);
	});
});

describe("aurora > component > fragments (multi-root + composition)", () => {
	it("a multi-root template attaches every root to the container", () => {
		const Header = component(() => html`<h1>title</h1><nav>nav</nav>`);
		render(Header(), container);
		expect(container.querySelectorAll("h1, nav")).toHaveLength(2);
	});

	it("an array of TemplateResults renders as siblings", () => {
		const items = [html`<li>a</li>`, html`<li>b</li>`, html`<li>c</li>`];
		render(html`<ul>${items}</ul>`, container);
		const li = container.querySelectorAll("li");
		expect(li).toHaveLength(3);
		expect(li[0].textContent).toBe("a");
		expect(li[2].textContent).toBe("c");
	});

	it("nested components compose without wrapper elements", () => {
		const Item = component<{ label: string }>(
			({ label }) => html`<li>${label}</li>`,
		);
		const List = component(
			() => html`<ul>${[Item({ label: "x" }), Item({ label: "y" })]}</ul>`,
		);
		render(List(), container);
		const li = container.querySelectorAll("li");
		expect(li).toHaveLength(2);
		expect(li[0].textContent).toBe("x");
		expect(li[1].textContent).toBe("y");
	});

	it("child component cleanups bubble to the outer dispose", () => {
		const cleanup = vi.fn();
		const Child = component(() => {
			onUnmount(cleanup);
			return html`<p>child</p>`;
		});
		const Parent = component(() => html`<div>${Child()}</div>`);
		const dispose = render(Parent(), container);
		dispose();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});
});
