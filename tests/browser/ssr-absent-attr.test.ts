import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	html,
	hydrate,
	render,
	renderToString,
	signal,
} from "../../src/index.js";

/**
 * Real-Chromium proof that an absent attribute stays absent across SSR.
 *
 * The client never writes an attribute whose value is null, undefined or false.
 * The server wrote it empty, and hydration does not replay a static value, so
 * `id="" name="" autocomplete=""` stayed in the DOM for good — Chrome flags the
 * autocomplete, and an empty `id` is one a `<label for>` can match.
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

function attributes(root: Element): string[][] {
	return [...root.querySelectorAll("*")].map((el) =>
		[...el.attributes].map((a) => `${a.name}=${a.value}`),
	);
}

describe("aurora > browser > absent attributes across SSR", () => {
	it("hydrates to the DOM the client renders, with no empty attribute left", () => {
		const label = signal<string | undefined>(undefined);
		const factory = () =>
			html`<input id="${undefined}" name="${null}" autocomplete="${false}" placeholder="${() => undefined}" aria-label="${label}" type="search">`;

		const client = document.createElement("div");
		render(factory(), client);

		container.innerHTML = renderToString(factory());
		hydrate(container, factory);
		expect(attributes(container)).toEqual(attributes(client));
		expect(attributes(container)).toEqual([["type=search"]]);
		expect(warnSpy.mock.calls).toEqual([]);

		// A reactive one still appears once it has a value.
		label("Filter");
		expect(container.querySelector("input")?.getAttribute("aria-label")).toBe(
			"Filter",
		);
	});
});
