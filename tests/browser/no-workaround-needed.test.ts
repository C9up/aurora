import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, hydrate, renderToString, signal } from "../../src/index.js";

/**
 * The shapes fluveo had to rewrite, written the natural way again. Each one is
 * the form its comments describe as broken — kept here so the workaround never
 * has to come back.
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

function warnings(): string[] {
	return warnSpy.mock.calls
		.map((c: unknown[]) => String(c[0]))
		.filter((m: string) => m.includes("[aurora]"));
}

const Icon = (cls: string) =>
	html`<svg viewBox="0 0 24 24" class="shrink-0 ${cls}"><path d="M12 9v4" /></svg>`;

describe("aurora > browser > fluveo's original shapes", () => {
	/** Alert.js: one template per tone existed only to keep `${message}` first. */
	it("an Alert built from ONE template with a leading icon binds its message", () => {
		const message = signal("Impossible d'enregistrer");
		const tone = signal("border-destructive/30");
		const Alert = () =>
			html`<div role="alert" class="flex items-center gap-2 ${() => tone()}">
				${Icon("size-4")}<span>${message}</span>
			</div>`;

		container.innerHTML = renderToString(Alert());
		hydrate(container, Alert);

		expect(warnings()).toEqual([]);
		expect(container.querySelector("span")?.textContent).toBe(
			"Impossible d'enregistrer",
		);
		// The static classes survive beside the reactive one.
		const el = container.querySelector("div[role=alert]");
		expect(el?.className).toContain("flex");
		expect(el?.className).toContain("items-center");
		expect(el?.className).toContain("border-destructive/30");

		message("Enregistré");
		tone("border-success/30");
		expect(container.querySelector("span")?.textContent).toBe("Enregistré");
		expect(el?.className).toContain("flex");
		expect(el?.className).toContain("border-success/30");
	});

	/** AccountMenu.js: an icon before a row label made following rows render empty. */
	it("rows with a leading icon all bind their labels", () => {
		const rows = signal<string[]>([]);
		const Menu = () =>
			html`<ul>
				${() => rows().map((label) => html`<li>${Icon("size-3")}<span>${label}</span></li>`)}
			</ul>`;

		container.innerHTML = renderToString(Menu());
		hydrate(container, Menu);

		rows(["Profil", "Équipe", "Déconnexion"]);

		const labels = Array.from(container.querySelectorAll("li span")).map(
			(n) => n.textContent,
		);
		expect(labels).toEqual(["Profil", "Équipe", "Déconnexion"]);
		expect(container.querySelectorAll("li svg").length).toBe(3);
		expect(warnings()).toEqual([]);
	});

	/** Button.js: base classes had to move inside the function to survive. */
	it("a button keeps its base classes beside a reactive variant", () => {
		const variant = signal("bg-primary text-primary-foreground");
		const Button = () =>
			html`<button class="inline-flex items-center rounded-md ${() => variant()}">
				${"Enregistrer"}
			</button>`;

		container.innerHTML = renderToString(Button());
		hydrate(container, Button);

		const button = container.querySelector("button");
		expect(button?.className).toContain("inline-flex");
		expect(button?.className).toContain("rounded-md");
		expect(button?.className).toContain("bg-primary");
		expect(button?.textContent?.trim()).toBe("Enregistrer");

		variant("bg-destructive text-white");
		expect(button?.className).toContain("inline-flex");
		expect(button?.className).toContain("bg-destructive");
		expect(button?.className).not.toContain("bg-primary");
	});
});
