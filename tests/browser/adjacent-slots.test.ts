import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, hydrate, renderToString, signal } from "../../src/index.js";

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
const warnings = () =>
	warnSpy.mock.calls
		.map((c: unknown[]) => String(c[0]))
		.filter((m: string) => m.includes("[aurora]"));

const Icon = () => html`<svg viewBox="0 0 24 24"><path d="M12 9v4" /></svg>`;

describe("aurora > adjacent slots with NO element between them", () => {
	it("a text slot directly after a nested template — no wrapper span", () => {
		const message = signal("Impossible d'enregistrer");
		const Alert = () => html`<div role="alert">${Icon()}${message}</div>`;

		container.innerHTML = renderToString(Alert());
		hydrate(container, Alert);

		const el = container.querySelector("div[role=alert]");
		expect(el?.querySelector("svg")).not.toBeNull();
		expect(el?.textContent?.trim()).toBe("Impossible d'enregistrer");
		expect(el?.querySelector("span")).toBeNull();
		expect(warnings()).toEqual([]);

		message("Enregistré");
		expect(el?.textContent?.trim()).toBe("Enregistré");
	});

	it("three bare slots in a row", () => {
		const a = signal("un");
		const b = signal("deux");
		const View = () => html`<p>${Icon()}${a} — ${b}</p>`;

		container.innerHTML = renderToString(View());
		hydrate(container, View);

		expect(container.querySelector("p")?.textContent?.trim()).toBe("un — deux");
		a("UN");
		b("DEUX");
		expect(container.querySelector("p")?.textContent?.trim()).toBe("UN — DEUX");
		expect(warnings()).toEqual([]);
	});

	it("two nested templates back to back, then a text slot", () => {
		const label = signal("Profil");
		const Row = () => html`<li>${Icon()}${Icon()}${label}</li>`;

		container.innerHTML = renderToString(Row());
		hydrate(container, Row);

		expect(container.querySelectorAll("li svg").length).toBe(2);
		expect(container.querySelector("li")?.textContent?.trim()).toBe("Profil");
		label("Équipe");
		expect(container.querySelector("li")?.textContent?.trim()).toBe("Équipe");
		expect(warnings()).toEqual([]);
	});

	it("bare slots inside a reactive list item", () => {
		const rows = signal<string[]>([]);
		const List = () =>
			html`<ul>${() => rows().map((r) => html`<li>${Icon()}${r}</li>`)}</ul>`;

		container.innerHTML = renderToString(List());
		hydrate(container, List);
		rows(["Alice", "Bob"]);

		const items = Array.from(container.querySelectorAll("li"));
		expect(items.map((i) => i.textContent?.trim())).toEqual(["Alice", "Bob"]);
		expect(container.querySelectorAll("li svg").length).toBe(2);
		expect(warnings()).toEqual([]);
	});
});
