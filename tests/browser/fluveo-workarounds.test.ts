import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, hydrate, renderToString, signal } from "../../src/index.js";

/**
 * The three shapes fluveo had to write AROUND. Each one is a plain, reasonable
 * template that a user would write without thinking twice — so each failure
 * costs them a workaround plus the comment explaining it.
 */

let container: HTMLElement;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warnSpy.mockRestore();
	container.remove();
});

function auroraWarnings(): string[] {
	return warnSpy.mock.calls
		.map((c: unknown[]) => String(c[0]))
		.filter((m: string) => m.includes("[aurora]"));
}

const Icon = (cls: string) =>
	html`<svg viewBox="0 0 24 24" class="shrink-0 ${cls}"><path d="M12 9v4" /></svg>`;

describe("aurora > browser > shapes fluveo works around", () => {
	/**
	 * A nested template sitting BEFORE another slot. fluveo: "the nested
	 * `${Icon()}` fragment sat BEFORE `${props.message}` and shifted the binding
	 * path aurora had computed for it, so the message never bound and every error
	 * in the app rendered as an empty coloured box".
	 */
	it("binds a slot that follows a nested template", () => {
		const message = signal("Quelque chose a échoué");
		const factory = () =>
			html`<div role="alert" class="banner">${Icon("size-4")}<span>${message}</span></div>`;

		container.innerHTML = renderToString(factory());
		hydrate(container, factory);

		expect(auroraWarnings()).toEqual([]);
		expect(container.querySelector("span")?.textContent).toBe(
			"Quelque chose a échoué",
		);

		message("Autre chose");
		expect(container.querySelector("span")?.textContent).toBe("Autre chose");
	});

	/**
	 * Static classes beside a reactive one. fluveo: "a static `class="..."` prefix
	 * beside a `() =>` slot would wipe the statics (aurora mixed-class gotcha), so
	 * the base classes live inside the function too".
	 */
	it("keeps the static part of a class when a reactive slot follows it", () => {
		const variant = signal("bg-primary");
		const factory = () =>
			html`<button class="inline-flex items-center ${() => variant()}">ok</button>`;

		container.innerHTML = renderToString(factory());
		hydrate(container, factory);

		const button = container.querySelector("button");
		expect(button?.className).toContain("inline-flex");
		expect(button?.className).toContain("items-center");
		expect(button?.className).toContain("bg-primary");

		variant("bg-destructive");
		expect(button?.className).toContain("inline-flex");
		expect(button?.className).toContain("bg-destructive");
		expect(button?.className).not.toContain("bg-primary");
	});

	/**
	 * A nested template inserted during a reactive re-render. fluveo: "aurora's
	 * reconciler throws `el.setAttribute is not a function` when a NESTED template
	 * is inserted during a reactive re-render (e.g. a table row's chevron)".
	 */
	it("inserts a nested template during a reactive re-render", () => {
		const rows = signal<string[]>([]);
		const factory = () =>
			html`<ul>
				${() => rows().map((label) => html`<li>${Icon("size-3")}<span>${label}</span></li>`)}
			</ul>`;

		container.innerHTML = renderToString(factory());
		hydrate(container, factory);

		expect(() => rows(["Alice", "Bob"])).not.toThrow();

		const items = container.querySelectorAll("li");
		expect(items.length).toBe(2);
		expect(items[0]?.querySelector("svg")).not.toBeNull();
		expect(items[0]?.querySelector("span")?.textContent).toBe("Alice");
		expect(auroraWarnings()).toEqual([]);
	});
});
