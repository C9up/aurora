import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	component,
	html,
	hydrate,
	renderToString,
	signal,
} from "../../src/index.js";

let container: HTMLElement;

beforeEach(() => {
	container = document.createElement("div");
});

describe("aurora > hydrate > SSR roundtrip", () => {
	it("adopts SSR markup and wires reactive bindings", () => {
		const factory = () => {
			const count = signal(5);
			return html`<output @click="${() => count(count() + 1)}">${count}</output>`;
		};
		const Counter = component(factory);

		// Server: produce HTML from the SAME factory shape.
		const ssr = renderToString(Counter());
		container.innerHTML = ssr;
		// Sanity — SSR rendered the initial value, no @click on the wire.
		expect(container.textContent).toBe("5");
		expect(container.innerHTML).not.toContain("@click");

		// Client: hydrate against the live DOM.
		hydrate(container, Counter);
		const out = container.querySelector("output") as HTMLOutputElement;
		out.click();
		out.click();
		// Each click bumps the counter through the now-attached listener.
		expect(out.textContent?.trim()).toBe("7");
	});

	it("dispose detaches listeners without removing the DOM nodes", () => {
		let clicks = 0;
		const factory = () => html`<button @click="${() => clicks++}">x</button>`;
		container.innerHTML = renderToString(factory());

		const dispose = hydrate(container, factory);
		const btn = container.querySelector("button") as HTMLButtonElement;
		btn.click();
		expect(clicks).toBe(1);

		dispose();
		btn.click();
		expect(clicks).toBe(1); // listener removed, DOM kept
		expect(container.querySelector("button")).not.toBeNull();
	});

	it("hydrates reactive attribute bindings", () => {
		const factory = () => {
			const cls = signal("on");
			return html`<span class="${cls}" @click="${() => cls("off")}">x</span>`;
		};
		const Wrap = component(factory);
		container.innerHTML = renderToString(Wrap());
		expect(container.querySelector("span")?.getAttribute("class")).toBe("on");
		hydrate(container, Wrap);
		(container.querySelector("span") as HTMLSpanElement).click();
		expect(container.querySelector("span")?.getAttribute("class")).toBe("off");
	});
});

describe("aurora > hydrate > mismatch surfacing", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("warns when the live DOM is missing a slot path", () => {
		// Client template expects a <span> with an attribute slot and a
		// child text slot.
		const Wrap = component(() => {
			const cls = signal("on");
			return html`<span class="${cls}">${"hi"}</span>`;
		});
		// SSR markup that diverges from the template shape: the <span>
		// (and therefore every slot path under it) is gone. Hydration
		// should warn instead of silently no-op'ing.
		container.innerHTML = "";

		hydrate(container, Wrap);

		expect(warnSpy).toHaveBeenCalled();
		const messages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			messages.some((m: string) => m.includes("[aurora] hydration mismatch")),
		).toBe(true);
		expect(
			messages.some((m: string) => m.includes("did you forget to rerender")),
		).toBe(true);
	});

	it("skips an attr-slot binding (no crash) when its path lands on a non-element", () => {
		// Reactive class attr on the root <input>. Diverging SSR markup puts a
		// Text node where the <input> is expected, so the attr path resolves to a
		// Text node. Before the type guard this threw "setAttribute is not a
		// function" inside the binding effect; now it warns and skips (fail-soft).
		const Wrap = component(() => html`<input class="${signal("on")}" />`);
		container.innerHTML = "stray text node";

		expect(() => hydrate(container, Wrap)).not.toThrow();
		expect(warnSpy).toHaveBeenCalled();
		const messages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(messages.some((m: string) => m.includes("non-element node"))).toBe(
			true,
		);
	});

	it("[ROOT] text interpolation adjacent to static text keeps the following attr binding aligned", () => {
		// `Hello ${x}!` — the client template splits this into 3 nodes (text,
		// slot-comment, text) but SSR inlines the value, so the browser MERGES
		// the adjacent text nodes into one. The node count drops, shifting the
		// path of the following <span>'s class slot → the binding desyncs.
		const cls = signal("on");
		const factory = () =>
			html`<div>Hello ${"World"}!<span class="${cls}">x</span></div>`;
		container.innerHTML = renderToString(factory());
		expect(container.querySelector("span")?.getAttribute("class")).toBe("on");

		hydrate(container, factory);
		cls("off");
		// The class binding must still target the <span>.
		expect(container.querySelector("span")?.getAttribute("class")).toBe("off");
	});

	it("a non-empty reactive list keeps a following text-slot binding aligned", () => {
		// The reactive array is rendered at SSR; each item has its own text-slot
		// marker pair. Hydration must consume those pairs (recurse into items) or
		// the cursor desyncs and the following `${tail}` binds the wrong range.
		const items = signal([{ name: "Alice" }, { name: "Bob" }]);
		const tail = signal("hello");
		const factory = () =>
			html`<div><ul>${() => items().map((it) => html`<li>${it.name}</li>`)}</ul><p>${tail}</p></div>`;
		container.innerHTML = renderToString(factory());
		hydrate(container, factory);

		expect(warnSpy).not.toHaveBeenCalled();
		tail("changed");
		expect(container.querySelector("p")?.textContent).toBe("changed");
		expect(container.querySelector("li")?.textContent).toBe("Alice");
	});

	it("does NOT warn on a matching SSR roundtrip", () => {
		const Wrap = component(() => {
			const v = signal(1);
			return html`<output class="${v}">${v}</output>`;
		});
		container.innerHTML = renderToString(Wrap());
		hydrate(container, Wrap);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});

describe("aurora > hydrate > reactive nested template (boundary-marker swap)", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		const { resetHydrateWarnings } = await import("../../src/hydrate.js");
		resetHydrateWarnings();
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("SSR emits boundary markers around a reactive nested-template slot", () => {
		const inner = signal(html`<em>first</em>`);
		const Wrap = component(() => html`<div>${inner}</div>`);
		const ssr = renderToString(Wrap());
		expect(ssr).toContain("<!--$-->");
		expect(ssr).toContain("<!--/$-->");
		expect(ssr).toContain("<em>first</em>");
	});

	it("keeps the nested subtree REACTIVE after hydration (swaps on signal change)", () => {
		const inner = signal(html`<em>first</em>`);
		const Wrap = component(() => html`<div>${inner}</div>`);
		container.innerHTML = renderToString(Wrap());
		expect(container.querySelector("em")?.textContent).toBe("first");

		hydrate(container, Wrap);
		// Initial SSR markup reused, no warning (markers present).
		expect(container.querySelector("em")?.textContent).toBe("first");
		expect(warnSpy).not.toHaveBeenCalled();

		// The crux: changing the signal swaps the subtree in place.
		inner(html`<strong>second</strong>`);
		expect(container.querySelector("strong")?.textContent).toBe("second");
		expect(container.querySelector("em")).toBeNull();

		// And again, proving it stays reactive across multiple swaps.
		inner(html`<span>third</span>`);
		expect(container.querySelector("span")?.textContent).toBe("third");
		expect(container.querySelector("strong")).toBeNull();
	});

	it("swaps a nested template for a scalar and back", () => {
		const v = signal<unknown>(html`<em>tpl</em>`);
		const Wrap = component(() => html`<div>${v}</div>`);
		container.innerHTML = renderToString(Wrap());
		hydrate(container, Wrap);
		expect(container.querySelector("em")?.textContent).toBe("tpl");

		v("plain text");
		expect(container.querySelector("em")).toBeNull();
		expect(container.textContent).toContain("plain text");

		v(html`<b>back</b>`);
		expect(container.querySelector("b")?.textContent).toBe("back");
	});

	it("disposes the swapped-out subtree's effects (no leak across swaps)", () => {
		const which = signal<"a" | "b">("a");
		const aTick = signal(0);
		let aRuns = 0;
		const Wrap = component(
			() =>
				html`<div>${() =>
					which() === "a"
						? html`<span>${() => {
								aRuns += 1;
								return aTick();
							}}</span>`
						: html`<i>b</i>`}</div>`,
		);
		container.innerHTML = renderToString(Wrap());
		hydrate(container, Wrap);
		const runsAfterHydrate = aRuns;

		// Swap A away — its inner effect must be disposed.
		which("b");
		expect(container.querySelector("i")?.textContent).toBe("b");
		const runsAfterSwap = aRuns;

		// Mutating A's signal now must NOT re-run the disposed effect.
		aTick(99);
		expect(aRuns).toBe(runsAfterSwap);
		expect(runsAfterHydrate).toBeGreaterThan(0);
	});

	it("swaps create nodes in the ROOT's own document (no cross-document leak between hydrate calls)", () => {
		// Two independent roots in two different Documents. A second
		// hydrate() must not clobber the first root's document — a swap in
		// root 1 must produce text nodes owned by doc 1, not doc 2. This
		// guards the regression where the active document was a module
		// global overwritten by each hydrate() call.
		const doc2 = document.implementation.createHTMLDocument("d2");

		const v1 = signal<unknown>(html`<em>one</em>`);
		const Wrap1 = component(() => html`<div>${v1}</div>`);
		const root1 = document.createElement("div");
		root1.innerHTML = renderToString(Wrap1());
		hydrate(root1, Wrap1);

		const v2 = signal<unknown>(html`<em>two</em>`);
		const Wrap2 = component(() => html`<div>${v2}</div>`);
		const root2 = doc2.createElement("div");
		root2.innerHTML = renderToString(Wrap2());
		hydrate(root2, Wrap2);

		// Swap root 1 to a SCALAR — that path goes through createTextNode,
		// the exact spot that used the shared global document.
		v1("scalar-one");
		const swapped = root1.querySelector("div")?.lastChild;
		// (lastChild before the end marker is the new text node region)
		expect(root1.textContent).toContain("scalar-one");
		// The created text node must belong to root1's document, not doc2.
		const textNode = Array.from(
			root1.querySelectorAll("div")[0].childNodes,
		).find((n) => n.nodeType === 3 && n.textContent === "scalar-one");
		expect(textNode?.ownerDocument).toBe(root1.ownerDocument);
		expect(textNode?.ownerDocument).not.toBe(doc2);
		void swapped;
	});
});

describe("aurora > hydrate > empty text slots (alignment regression)", () => {
	it("hydrates an empty reactive text slot and updates it after a signal change", () => {
		const v = signal("");
		const factory = () => html`<p>${() => v()}</p>`;
		const ssr = renderToString(factory());
		// The empty slot still emits its boundary-marker pair so its position
		// survives (hydration materializes the text node inside the range).
		expect(ssr).toContain("<!--$--><!--/$-->");
		container.innerHTML = ssr;

		hydrate(container, factory);
		const p = container.querySelector("p") as HTMLParagraphElement;
		expect(p.textContent).toBe("");
		v("hello");
		expect(p.textContent).toBe("hello");
	});

	it("keeps a sibling binding wired when a leading text slot renders empty", () => {
		const err = signal("");
		let clicks = 0;
		const factory = () =>
			html`<div><p>${() => err()}</p><button @click="${() => clicks++}">go</button></div>`;
		container.innerHTML = renderToString(factory());

		hydrate(container, factory);
		// The empty <p> slot must not desync the sibling button's @click.
		const btn = container.querySelector("button") as HTMLButtonElement;
		btn.click();
		expect(clicks).toBe(1);
		// …and the empty slot itself is now reactive.
		err("oops");
		expect(container.querySelector("p")?.textContent).toBe("oops");
	});

	it("does not warn 'slot not found' for an empty text slot", () => {
		const v = signal("");
		const factory = () => html`<p>${() => v()}</p>`;
		container.innerHTML = renderToString(factory());
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		hydrate(container, factory);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("aurora > hydrate > direct (non-reactive) nested-template slots", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		const { resetHydrateWarnings } = await import("../../src/hydrate.js");
		resetHydrateWarnings();
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("SSR wraps a DIRECT multi-node nested template in boundary markers", () => {
		// `${child}` is a plain TemplateResult interpolation — component
		// composition (`html`${Layout({…})}``), NOT `${() => …}`. It must get the
		// same boundary markers a reactive structured slot gets, so its node range
		// stays locatable and the following slot paths don't shift.
		const factory = () => {
			const child = html`<p>a</p><p>b</p>`;
			return html`<section>${child}</section>`;
		};
		const ssr = renderToString(factory());
		expect(ssr).toContain("<!--$-->");
		expect(ssr).toContain("<!--/$-->");
		expect(ssr).toContain("<p>a</p><p>b</p>");
	});

	it("keeps a sibling binding wired after a DIRECT multi-node nested template", () => {
		// The bug: the direct child expands to 2 nodes but (pre-fix) carries no
		// markers, while the client template counts it as 1 comment → the
		// button's @click path shifts onto the wrong node → dead listener, and
		// a re-render later hits the unguarded resolvePath crash.
		let clicks = 0;
		const factory = () => {
			const child = html`<p>a</p><p>b</p>`;
			return html`<section>${child}<button @click="${() => clicks++}">go</button></section>`;
		};
		container.innerHTML = renderToString(factory());
		expect(container.querySelectorAll("p").length).toBe(2);
		expect(container.querySelector("button")?.textContent).toBe("go");

		hydrate(container, factory);
		expect(warnSpy).not.toHaveBeenCalled();
		const btn = container.querySelector("button") as HTMLButtonElement;
		btn.click();
		expect(clicks).toBe(1); // listener wired to the RIGHT node, not a shifted one
	});
});
