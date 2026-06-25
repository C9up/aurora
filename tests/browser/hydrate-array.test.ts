import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, hydrate, renderToString, signal } from "../../src/index.js";

/**
 * A reactive ARRAY slot that is NON-EMPTY at SSR, followed by a sibling slot.
 * Each item carries its own text slot (→ its own SSR marker pair). If firstRun
 * hydration doesn't recurse into array items, their pairs go unconsumed and the
 * global marker cursor desyncs — every slot AFTER the list resolves against the
 * wrong pair ("slot path not found") and its binding is skipped ("present in the
 * DOM but not painted"). This is fluveo's /settings VAT list + sidebar nav case.
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

describe("aurora > browser > reactive array (non-empty at SSR) + sibling", () => {
	it("keeps a following TEXT-slot binding aligned after a non-empty list", () => {
		const items = signal([
			{ id: 1, name: "Alice" },
			{ id: 2, name: "Bob" },
		]);
		const tail = signal("hello");
		// A TEXT slot after the list — text slots consume marker pairs, so if the
		// list's item pairs aren't consumed at hydration the cursor desyncs and
		// this binding wires to the wrong range.
		const factory = () =>
			html`<div><ul>${() => items().map((it) => html`<li>${it.name}</li>`)}</ul><p class="tail">${tail}</p></div>`;

		container.innerHTML = renderToString(factory());
		expect(container.querySelectorAll("li").length).toBe(2);
		expect(container.querySelector("p.tail")?.textContent).toBe("hello");

		hydrate(container, factory);

		expect(auroraWarnings()).toEqual([]);
		// The <p> binding must update — it's wired to the <p>'s text node, not a
		// list item's range.
		tail("changed");
		expect(container.querySelector("p.tail")?.textContent).toBe("changed");
		// And the first <li> must NOT have been clobbered by the tail binding.
		expect(container.querySelector("li")?.textContent).toBe("Alice");
	});
});
