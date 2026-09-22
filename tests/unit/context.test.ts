/**
 * The context primitive, and the one rule that makes it work.
 *
 * Aurora evaluates eagerly: `Parent({ children: [Child()] })` runs `Child()`
 * first, so a provider only reaches descendants it creates itself, inside its
 * own setup. Every compound component in the set is built on that, which is
 * why it is asserted here rather than left to a doc-comment.
 */

import { describe, expect, it } from "vitest";
import {
	AuroraError,
	component,
	createContext,
	html,
	hydrate,
	inject,
	provide,
	render,
	renderToString,
	signal,
} from "../../src/index.js";

interface MenuState {
	readonly open: () => boolean;
	readonly toggle: () => void;
}

describe("context", () => {
	it("hands a value to a child created inside the provider's setup", () => {
		const MenuContext = createContext<string>("Menu");

		const Item = component(() => html`<li>${inject(MenuContext)}</li>`);
		const Menu = component(() => {
			provide(MenuContext, "from-the-menu");
			return html`<ul>${Item()}</ul>`;
		});

		const host = document.createElement("div");
		render(Menu(), host);
		expect(host.textContent).toBe("from-the-menu");
	});

	it("reaches a grandchild, not only a direct child", () => {
		const Ctx = createContext<string>("Deep");
		const Leaf = component(() => html`<i>${inject(Ctx)}</i>`);
		const Middle = component(() => html`<span>${Leaf()}</span>`);
		const Root = component(() => {
			provide(Ctx, "deep");
			return html`<div>${Middle()}</div>`;
		});

		const host = document.createElement("div");
		render(Root(), host);
		expect(host.textContent).toBe("deep");
	});

	it("shares live state, so a child's action moves the parent's signal", () => {
		// The real shape: a trigger toggles, content reads. Neither knows the
		// other, and no prop was threaded between them.
		const MenuContext = createContext<MenuState>("Menu");

		const Trigger = component(() => {
			const menu = inject(MenuContext);
			return html`<button @click=${() => menu.toggle()}>open</button>`;
		});
		const Content = component(() => {
			const menu = inject(MenuContext);
			return html`<div>${() => (menu.open() ? "shown" : "hidden")}</div>`;
		});
		const Menu = component(() => {
			const open = signal(false);
			provide(MenuContext, {
				open: () => open(),
				toggle: () => open((previous) => !previous),
			});
			return html`<div>${Trigger()}${Content()}</div>`;
		});

		const host = document.createElement("div");
		render(Menu(), host);
		expect(host.textContent).toContain("hidden");

		const button = host.querySelector("button");
		expect(button).not.toBeNull();
		button?.click();
		expect(host.textContent).toContain("shown");
	});

	it("gives the nearest provider, so nesting the same context shadows it", () => {
		const Ctx = createContext<string>("Nested");
		const Leaf = component(() => html`<i>${inject(Ctx)}</i>`);
		const Inner = component(() => {
			provide(Ctx, "inner");
			return html`<span>${Leaf()}</span>`;
		});
		const Outer = component(() => {
			provide(Ctx, "outer");
			return html`<div>${Leaf()}${Inner()}</div>`;
		});

		const host = document.createElement("div");
		render(Outer(), host);
		expect(host.textContent).toBe("outerinner");
	});

	it("falls back to the default when nothing provided a value", () => {
		const Ctx = createContext<string>("Optional", "fallback");
		const Solo = component(() => html`<i>${inject(Ctx)}</i>`);

		const host = document.createElement("div");
		render(Solo(), host);
		expect(host.textContent).toBe("fallback");
	});

	it("distinguishes two contexts that share a name", () => {
		// Identity is the symbol, not the name — two packages may both call
		// theirs "Menu" and must not read each other's value.
		const a = createContext<string>("Menu");
		const b = createContext<string>("Menu", "b-default");
		const Leaf = component(() => html`<i>${inject(a)}|${inject(b)}</i>`);
		const Root = component(() => {
			provide(a, "a-value");
			return html`<div>${Leaf()}</div>`;
		});

		const host = document.createElement("div");
		render(Root(), host);
		expect(host.textContent).toBe("a-value|b-default");
	});

	it("throws, naming the context, when there is no provider and no default", () => {
		const Ctx = createContext<string>("Select");
		const Orphan = component(() => html`<i>${inject(Ctx)}</i>`);

		expect(() => Orphan()).toThrowError(
			/No value provided for context "Select"/,
		);
		try {
			Orphan();
			expect.unreachable("inject should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(AuroraError);
			expect((error as AuroraError).code).toBe("E_AURORA_MISSING_CONTEXT");
		}
	});

	it("does NOT reach a child built before the provider ran — the rule", () => {
		// `Parent({ children: [Child()] })` evaluates `Child()` first. This is
		// the trap every compound component has to avoid, so it is pinned.
		const Ctx = createContext<string>("Eager");
		const Child = component(() => html`<i>${inject(Ctx)}</i>`);
		const Parent = component((props: { children: unknown }) => {
			provide(Ctx, "too-late");
			return html`<div>${props.children}</div>`;
		});

		expect(() => Parent({ children: Child() })).toThrowError(
			/No value provided for context "Eager"/,
		);
	});

	it("reaches a child passed as a thunk, because setup calls it", () => {
		// Same call site, one `() =>`: the provider now creates the child.
		const Ctx = createContext<string>("Lazy");
		const Child = component(() => html`<i>${inject(Ctx)}</i>`);
		const Parent = component((props: { children: () => unknown }) => {
			provide(Ctx, "in-time");
			return html`<div>${props.children()}</div>`;
		});

		const host = document.createElement("div");
		render(Parent({ children: () => Child() }), host);
		expect(host.textContent).toBe("in-time");
	});

	it("leaves nothing behind once the provider's setup returned", () => {
		// The stack is popped in `finally`, so a sibling rendered afterwards
		// must not see a value that is no longer in scope.
		const Ctx = createContext<string>("Scoped");
		const Root = component(() => {
			provide(Ctx, "scoped");
			return html`<div>ok</div>`;
		});
		const Sibling = component(() => html`<i>${inject(Ctx)}</i>`);

		render(Root(), document.createElement("div"));
		expect(() => Sibling()).toThrowError(/context "Scoped"/);
	});

	it("refuses `provide` outside a component setup", () => {
		const Ctx = createContext<string>("Loose");
		expect(() => provide(Ctx, "x")).toThrowError(AuroraError);
	});

	it("returns the provided value, so the provider keeps it in one statement", () => {
		const Ctx = createContext<{ id: string }>("Value");
		let seen: { id: string } | undefined;
		const Root = component(() => {
			seen = provide(Ctx, { id: "r1" });
			return html`<div>ok</div>`;
		});
		Root();
		expect(seen).toEqual({ id: "r1" });
	});
});

describe("context > server and hydration", () => {
	it("resolves during server rendering", () => {
		const Ctx = createContext<string>("Ssr");
		const Leaf = component(() => html`<i>${inject(Ctx)}</i>`);
		const Root = component(() => {
			provide(Ctx, "server-side");
			return html`<div>${Leaf()}</div>`;
		});

		expect(renderToString(Root())).toContain("server-side");
	});

	it("resolves again when the same tree hydrates", () => {
		// Hydration re-runs setup against existing markup. A context that
		// only worked on one of the two sides would be worse than none.
		const Ctx = createContext<() => string>("Both");
		const Leaf = component(() => {
			const label = inject(Ctx);
			return html`<i>${() => label()}</i>`;
		});
		const Root = component(() => {
			const label = signal("live");
			provide(Ctx, () => label());
			return html`<div>${Leaf()}</div>`;
		});

		const host = document.createElement("div");
		host.innerHTML = renderToString(Root());
		hydrate(host, Root);
		expect(host.textContent).toContain("live");
	});
});
