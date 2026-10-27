/**
 * A part built inside an accessor still reaches its provider.
 *
 * A reactive slot is called later than the setup it was written in — when it
 * mounts, and each time what it reads changes — and by then the provider's
 * frame is off the stack. So a list of compound parts that follows a signal,
 *
 *     Menu({ children: () => html`${() => items().map((i) => MenuItem(i))}` })
 *
 * threw E_AURORA_MISSING_CONTEXT on its first render: the one place the
 * library pushes content that changes was the one place context did not
 * reach. `html` now records the providers it was called under, and the
 * renderer puts them back around each call.
 */

import { describe, expect, it } from "vitest";
import {
	AuroraError,
	component,
	createContext,
	html,
	hydrate,
	inject,
	onMount,
	provide,
	render,
	renderToString,
	signal,
} from "../../src/index.js";

const MenuContext = createContext<string>("Menu");

const MenuItem = component(
	(props: { label: string }) =>
		html`<li>${inject(MenuContext)}:${props.label}</li>`,
);

function menu(items: () => readonly string[]) {
	const Menu = component((props: { children: () => unknown }) => {
		provide(MenuContext, "menu");
		return html`<ul>${props.children()}</ul>`;
	});
	return Menu({
		children: () => html`${() => items().map((label) => MenuItem({ label }))}`,
	});
}

describe("context > parts built inside an accessor", () => {
	it("reaches them on the first render, and on every re-run", () => {
		const items = signal<readonly string[]>(["a"]);
		const host = document.createElement("div");
		render(menu(items), host);
		expect(host.textContent).toBe("menu:a");

		items(["a", "b"]);
		expect(host.textContent).toBe("menu:amenu:b");
	});

	it("reaches them during server rendering", () => {
		const host = document.createElement("div");
		host.innerHTML = renderToString(menu(() => ["a", "b"]));
		expect(host.textContent).toBe("menu:amenu:b");
	});

	it("reaches them when the same tree hydrates, and after", () => {
		const items = signal<readonly string[]>(["a"]);
		const host = document.createElement("div");
		host.innerHTML = renderToString(menu(items));
		hydrate(host, () => menu(items));
		expect(host.textContent).toBe("menu:a");

		items(["a", "c"]);
		expect(host.textContent).toBe("menu:amenu:c");
	});

	it("keeps the nearest provider nearest", () => {
		// A provider created INSIDE the accessor shadows the one it was written
		// under, as it would anywhere else.
		const Inner = component((props: { children: () => unknown }) => {
			provide(MenuContext, "inner");
			return html`${props.children()}`;
		});
		const Outer = component(() => {
			provide(MenuContext, "outer");
			return html`<div>${() => Inner({ children: () => MenuItem({ label: "x" }) })}</div>`;
		});
		const host = document.createElement("div");
		render(Outer(), host);
		expect(host.textContent).toBe("inner:x");
	});

	it("does not let an accessor register hooks on the provider", () => {
		// Only `inject` sees the recorded providers. A hook registered from an
		// accessor would pile onto the provider at every re-run.
		const Root = component(() => {
			provide(MenuContext, "menu");
			return html`<div>${() => {
				onMount(() => {});
				return "never";
			}}</div>`;
		});
		expect(() => render(Root(), document.createElement("div"))).toThrowError(
			AuroraError,
		);
	});

	it("still refuses a part used outside any provider", () => {
		const host = document.createElement("div");
		expect(() =>
			render(html`<ul>${() => MenuItem({ label: "x" })}</ul>`, host),
		).toThrowError(/No value provided for context "Menu"/);
	});
});
