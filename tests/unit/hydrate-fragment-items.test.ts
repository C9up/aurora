/**
 * An item with no root element hydrates against its own nodes.
 *
 * A list collapsed each `<!--$-->…<!--/$-->` range of its markup to the
 * range's opening comment, then handed every item its share of that collapsed
 * list, which the item collapsed AGAIN. An opening comment whose closing one
 * had been dropped held the depth open, so an item that was a fragment of two
 * slots — a breadcrumb's `${separator}${link}` — lost its second one, and every
 * path resolved after it on the page was off: warnings far from the list, and
 * bindings, a button's click among them, silently skipped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	each,
	html,
	hydrate,
	renderToString,
	signal,
	type TemplateResult,
} from "../../src/index.js";

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warn.mockRestore();
});

const auroraWarnings = (): string[] =>
	warn.mock.calls
		.map((call: unknown[]) => String(call[0]))
		.filter((message: string) => message.includes("[aurora]"));

interface Crumb {
	label: string;
	href?: string;
}

const crumbs: Crumb[] = [{ label: "Home", href: "/" }, { label: "Here" }];

const separator = () => html`<svg data-separator></svg>`;

/** The breadcrumb's item: a separator, then a link or the current page. */
function crumb(item: Crumb, index: number): TemplateResult {
	return html`${index === 0 ? "" : separator()}${
		item.href === undefined
			? html`<span>${item.label}</span>`
			: html`<a href="${item.href}">${item.label}</a>`
	}`;
}

/** A page with the breadcrumb, then content that has to stay wired. */
function page(nav: () => TemplateResult) {
	const count = signal(0);
	const view = () =>
		html`${nav()}<main><p>${() => count()}</p><button @click=${() => count(count() + 1)}>+</button></main>`;
	const host = document.createElement("div");
	host.innerHTML = renderToString(view());
	hydrate(host, view);
	return { host, count };
}

describe("hydrating items that are fragments", () => {
	it("an array of them, the first opening on an empty slot", () => {
		const { host } = page(() => html`<nav>${crumbs.map(crumb)}</nav>`);
		expect(auroraWarnings()).toEqual([]);
		host.querySelector("button")?.click();
		expect(host.querySelector("p")?.textContent).toBe("1");
	});

	it("an array of them with both slots filled", () => {
		const pair = (n: number) => html`${n}${html`<b>${n}</b>`}`;
		const { host } = page(() => html`<nav>${[1, 2, 3].map(pair)}</nav>`);
		expect(auroraWarnings()).toEqual([]);
		host.querySelector("button")?.click();
		expect(host.querySelector("p")?.textContent).toBe("1");
	});

	it("a keyed list of them", () => {
		const list = signal(crumbs);
		const { host } = page(
			() =>
				html`<nav>${each(
					list,
					(item) => item.label,
					(item, index) => crumb(item(), index()),
				)}</nav>`,
		);
		expect(auroraWarnings()).toEqual([]);
		host.querySelector("button")?.click();
		expect(host.querySelector("p")?.textContent).toBe("1");
		// The list still owns its rows: a reorder moves the server's nodes.
		const link = host.querySelector("a");
		list([...crumbs].reverse());
		expect(host.querySelector("a")).toBe(link);
		expect(host.querySelector("nav")?.lastElementChild).toBe(link);
	});
});
