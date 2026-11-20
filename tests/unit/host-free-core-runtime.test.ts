// @vitest-environment node
/**
 * The host-free entries load and work where there is no DOM at all.
 *
 * Run in Node's bare environment: no `document`, no `window`. A component is
 * built through `@c9up/aurora/core` and read back through
 * `@c9up/aurora/renderer`, the way a native renderer would — and nothing on
 * that path may reach for the DOM, at load or at call.
 */

import { describe, expect, it } from "vitest";

describe("@c9up/aurora/core without a DOM", () => {
	it("runs in an environment that has no document", () => {
		expect(Reflect.has(globalThis, "document")).toBe(false);
		expect(Reflect.has(globalThis, "window")).toBe(false);
	});

	it("builds a component, its template, its list and its form", async () => {
		const core = await import("../../src/core.js");
		const renderer = await import("../../src/renderer.js");

		const mounted: string[] = [];
		const items = core.signal<readonly string[]>(["a", "b"]);
		const done = core.memo(() => items().length);
		const Todo = core.component((props: { title: string }) => {
			core.onMount(() => {
				mounted.push(props.title);
			});
			return core.html`<section class="${core.cn("p-2", { hidden: false })}">
				<h1>${props.title}</h1>
				<ul>${core.each(
					items,
					(item) => item,
					(item) => core.html`<li>${item}</li>`,
				)}</ul>
				<p>${done}</p>
			</section>`;
		});

		const result = Todo({ title: "Today" });

		expect(core.isTemplateResult(result)).toBe(true);
		expect(result.strings.join("")).toContain("<section");
		const lifecycle = renderer.readComponentLifecycle(result);
		expect(lifecycle?.mountHooks).toHaveLength(1);
		const list = result.values.map((value) => renderer.readEach(value));
		expect(list.filter((entry) => entry !== undefined)).toHaveLength(1);
		expect(done()).toBe(2);
		items(["a", "b", "c"]);
		expect(done()).toBe(3);
		// Mount hooks are the renderer's to run, once its nodes are in place.
		for (const hook of lifecycle?.mountHooks ?? []) hook();
		expect(mounted).toEqual(["Today"]);

		const login = core.form({
			initial: { email: "" },
			submit: async () => undefined,
		});
		login.set("email", "a@b.c");
		expect(login.values().email).toBe("a@b.c");
	});

	it("scans a template the way the DOM renderer does", async () => {
		const renderer = await import("../../src/renderer.js");
		const scanner = new renderer.TemplateScanner();
		scanner.consume("<a href=");
		expect(() => renderer.assertBindable(scanner)).not.toThrow();
		const script = new renderer.TemplateScanner();
		script.consume("<script>");
		expect(() => renderer.assertBindable(script)).toThrow();
	});
});
