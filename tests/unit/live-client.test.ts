/**
 * Live client runtime (Stage 5) — hydrate SSR HTML, apply inbound patches by
 * setting mirror signals (aurora updates the DOM), and forward
 * `data-live-click` interactions through the injected transport. happy-dom.
 */
import { describe, expect, it } from "vitest";
import {
	html,
	liveClient,
	type LiveClientTransport,
	renderToString,
	signal,
	type SlotPatch,
} from "../../src/index.js";

/** Captures the patch subscriber + posted events; lets the test deliver patches. */
function fakeTransport() {
	let handler: ((patch: SlotPatch[]) => void) | undefined;
	const posts: Array<{ id: string; event: string }> = [];
	return {
		posts,
		deliver(patch: SlotPatch[]): void {
			handler?.(patch);
		},
		subscribe(_channel: string, h: (patch: SlotPatch[]) => void): () => void {
			handler = h;
			return () => {
				handler = undefined;
			};
		},
		post(id: string, event: string): void {
			posts.push({ id, event });
		},
	} satisfies LiveClientTransport & {
		posts: Array<{ id: string; event: string }>;
		deliver(patch: SlotPatch[]): void;
	};
}

describe("aurora > live client", () => {
	it("applies an inbound patch to the hydrated DOM", () => {
		const count = signal(0);
		const view = () =>
			html`<button data-live-click="increment">Count: <span>${count}</span></button>`;
		const container = document.createElement("div");
		container.innerHTML = renderToString(view());

		const transport = fakeTransport();
		const dispose = liveClient({
			container,
			factory: view,
			mount: { id: "abc", channel: "live/abc" },
			transport,
		});

		expect(container.textContent).toContain("Count: 0");
		transport.deliver([{ slot: 0, value: "1" }]); // patch over the channel
		expect(container.textContent).toContain("Count: 1");
		transport.deliver([{ slot: 0, value: "42" }]);
		expect(container.textContent).toContain("Count: 42");
		dispose();
	});

	it("forwards a data-live-click interaction through the transport", () => {
		const count = signal(0);
		const view = () =>
			html`<button data-live-click="increment">Count: <span>${count}</span></button>`;
		const container = document.createElement("div");
		container.innerHTML = renderToString(view());

		const transport = fakeTransport();
		const dispose = liveClient({
			container,
			factory: view,
			mount: { id: "abc", channel: "live/abc" },
			transport,
		});

		container.querySelector("button")?.dispatchEvent(
			new Event("click", { bubbles: true }),
		);
		expect(transport.posts).toEqual([{ id: "abc", event: "increment" }]);
		dispose();
	});

	it("dispose stops applying patches and forwarding clicks", () => {
		const count = signal(0);
		const view = () =>
			html`<button data-live-click="increment">Count: <span>${count}</span></button>`;
		const container = document.createElement("div");
		container.innerHTML = renderToString(view());

		const transport = fakeTransport();
		const dispose = liveClient({
			container,
			factory: view,
			mount: { id: "abc", channel: "live/abc" },
			transport,
		});
		dispose();

		transport.deliver([{ slot: 0, value: "9" }]);
		expect(container.textContent).toContain("Count: 0"); // patch ignored
		container.querySelector("button")?.dispatchEvent(
			new Event("click", { bubbles: true }),
		);
		expect(transport.posts).toHaveLength(0); // click no longer forwarded
	});
});
