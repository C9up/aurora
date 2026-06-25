import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	component,
	html,
	hydrate,
	renderToString,
	signal,
} from "../../src/index.js";

/**
 * Real-Chromium hydration of fluveo's actual shape: a page whose whole body is a
 * DIRECT nested-template slot (`html`${Layout(...)}``), nesting more direct
 * templates (Sidebar → Nav), a reactive class attr, and a reactive list that is
 * EMPTY at SSR and populates client-side. This is where "slot path not found"
 * persisted and nav/list didn't paint.
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

const Nav = (links: () => Array<{ href: string; label: string }>) =>
	html`<nav class="${() => "flex flex-col"}">
		${() => links().map((l) => html`<a href="${l.href}">${l.label}</a>`)}
	</nav>`;

const Sidebar = (links: () => Array<{ href: string; label: string }>) =>
	html`<aside class="${() => "sidebar"}">
		${Nav(links)}
	</aside>`;

const Layout = (
	links: () => Array<{ href: string; label: string }>,
	children: unknown,
) =>
	html`<div class="layout">
		${Sidebar(links)}
		<main class="content">${children}</main>
	</div>`;

describe("aurora > browser > deep direct-template nesting + reactive list", () => {
	it("hydrates the layout and paints the list when it populates client-side", () => {
		const links = signal<Array<{ href: string; label: string }>>([]);
		const factory = () => html`${Layout(links, html`<h1>${"Dashboard"}</h1>`)}`;

		container.innerHTML = renderToString(factory());
		hydrate(container, factory);

		expect(auroraWarnings()).toEqual([]);
		expect(container.querySelector("main.content h1")?.textContent).toBe(
			"Dashboard",
		);

		// List populates after hydration (mirrors permissions/data loading).
		links([
			{ href: "/dashboard", label: "Dashboard" },
			{ href: "/team", label: "Team" },
		]);
		const items = container.querySelectorAll("nav a");
		expect(items.length).toBe(2);
		expect(items[0]?.getAttribute("href")).toBe("/dashboard");
		expect(items[1]?.textContent).toBe("Team");
	});
});

// Keep `component` referenced for parity with how fluveo defines layouts.
void component;
