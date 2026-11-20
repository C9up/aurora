import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	countRerenders,
	each,
	html,
	hydrate,
	memo,
	type RerenderCounter,
	renderToString,
	signal,
} from "../../src/index.js";

/**
 * In Chromium, a hydrated page that receives the same data again does not
 * move: no mutation, no lost caret, no slot rebuilt. The page is the shape
 * the apps poll: a keyed list whose rows show fields of objects re-fetched
 * every few seconds, a derived count read next to its source, and a field
 * bound with `.value` while something unrelated changes around it.
 */

let container: HTMLElement;
let counter: RerenderCounter;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	counter = countRerenders();
});

afterEach(() => {
	counter.stop();
	container.remove();
});

function fetched() {
	return [
		{ id: 1, name: "Ada", status: "open" },
		{ id: 2, name: "Grace", status: "closed" },
	];
}

describe("a hydrated page fed the same data again", () => {
	it("is left untouched, and its focused field keeps what the user typed", async () => {
		const rows = signal(fetched());
		const theme = signal("light");
		const draft = signal("");
		const open = memo(() => rows().filter((r) => r.status === "open").length);
		const view = () => html`
			<section class=${() => theme()}>
				<p>${() => `${open()} of ${rows().length} open`}</p>
				<input .value=${() => {
					theme();
					return draft();
				}} />
				<ul>${each(
					rows,
					(r) => r.id,
					(row) =>
						html`<li class=${() => row().status}>${() => row().name}</li>`,
				)}</ul>
			</section>
		`;
		container.innerHTML = renderToString(view());
		const observer = new MutationObserver(() => {});
		observer.observe(container, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
		hydrate(container, view);
		// Hydration rewrote nothing the server had written. All it adds is the
		// empty comment each list row starts at; the `.value` property is not an
		// attribute and does not show here.
		const adopted = observer.takeRecords().map((m) => ({
			type: m.type,
			added: [...m.addedNodes].map((n) => `${n.nodeName}:${n.textContent}`),
			removed: m.removedNodes.length,
		}));
		expect(adopted).toEqual([
			{ type: "childList", added: ["#comment:"], removed: 0 },
			{ type: "childList", added: ["#comment:"], removed: 0 },
		]);

		const input = container.querySelector("input");
		if (input === null) throw new Error("no input");
		input.focus();
		input.value = "half-typed";
		input.setSelectionRange(4, 4);

		rows(fetched());
		rows(fetched());
		expect(observer.takeRecords()).toEqual([]);
		expect(counter.counts()).toMatchObject({ slot: 0, list: 2, attribute: 0 });

		theme("dark");
		expect(observer.takeRecords().map((m) => m.attributeName)).toEqual([
			"class",
		]);
		expect(document.activeElement).toBe(input);
		expect(input.value).toBe("half-typed");
		expect(input.selectionStart).toBe(4);
		observer.disconnect();
	});
});
