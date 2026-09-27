import { describe, expect, it } from "vitest";
import { withIdScope } from "../../src/id.js";
import { byId, html, hydrate, renderToString, uid } from "../../src/index.js";
import { mountLiveSession } from "../../src/liveSession.js";

/**
 * Two hydration roots on one page.
 *
 * A page with a live component has two: `renderPage` builds the page root and
 * `liveClient` hydrates its own container. Both used to call `resetIds()` on a
 * counter shared by the whole module, so the second root minted the ids the
 * first was already using — two elements with one id, `byId` answering with
 * whichever came first in the document, and `aria-controls` on a trigger in one
 * root pointing at a panel in the other.
 *
 * A root now borrows a counter namespaced to itself rather than resetting the
 * shared one, which is what makes the order they hydrate in stop mattering.
 */

function widget(name: string): () => ReturnType<typeof html> {
	return () => {
		const id = uid("panel");
		return html`<div id="${id}">${name}</div>`;
	};
}

function hydrateInto(
	markup: string,
	containerId: string,
	factory: () => ReturnType<typeof html>,
): Element {
	const host = document.createElement("div");
	host.id = containerId;
	host.innerHTML = markup;
	document.body.appendChild(host);
	hydrate(host, factory);
	return host;
}

describe("id scope > two roots on one page", () => {
	it("mint different ids, in either order", () => {
		const first = widget("first");
		const second = widget("second");
		// Rendered the way each root's server pass does it.
		const firstMarkup = withIdScope("root-a", first);
		const secondMarkup = withIdScope("root-b", second);

		const a = hydrateInto(renderToString(firstMarkup), "root-a", first);
		const b = hydrateInto(renderToString(secondMarkup), "root-b", second);
		try {
			const idA = a.firstElementChild?.id;
			const idB = b.firstElementChild?.id;
			expect(idA).toBe("root-a-panel-1");
			expect(idB).toBe("root-b-panel-1");
			expect(idA).not.toBe(idB);
			// The lookup a component does in onMount finds ITS node, not the other
			// root's — which is the failure the collision actually caused.
			expect(byId("root-a-panel-1")?.textContent).toBe("first");
			expect(byId("root-b-panel-1")?.textContent).toBe("second");
		} finally {
			a.remove();
			b.remove();
		}
	});

	it("does not leave the second root's namespace behind", () => {
		// `resetIds()` mutated shared state, so hydrating a root changed what
		// everything rendered afterwards would mint. Borrowing does not.
		const before = withIdScope("", () => uid("x"));
		const host = hydrateInto(
			renderToString(withIdScope("scoped", widget("w"))),
			"scoped",
			widget("w"),
		);
		host.remove();
		expect(withIdScope("", () => uid("x"))).toBe(before);
	});

	it("takes the namespace from the container's id by default", () => {
		const factory = widget("w");
		const host = hydrateInto(
			renderToString(withIdScope("named-root", factory)),
			"named-root",
			factory,
		);
		try {
			expect(host.firstElementChild?.id).toBe("named-root-panel-1");
		} finally {
			host.remove();
		}
	});

	it("leaves ids unprefixed when nothing names the root", () => {
		// An unnamed container is the one case with no namespace to share, and it
		// keeps the plain sequence rather than inventing one the server cannot
		// guess.
		const factory = widget("w");
		const host = hydrateInto(renderToString(factory()), "", factory);
		try {
			expect(host.firstElementChild?.id).toBe("panel-1");
		} finally {
			host.remove();
		}
	});
});

describe("id scope > a live session", () => {
	it("renders under its session id, which the client is handed too", () => {
		// The live container is named by the application, not the server, so the
		// session id is the only namespace both sides have. It travels in the
		// mount response, which `liveClient` already receives.
		const session = mountLiveSession(
			() => ({ view: widget("live")() }),
			"session-42",
		);
		expect(session.renderToString()).toContain('id="session-42-panel-1"');
	});

	it("does not share a sequence with the page that embeds it", () => {
		const pageFirst = withIdScope("aurora-root", () => uid("panel"));
		const session = mountLiveSession(
			() => ({ view: widget("live")() }),
			"session-42",
		);
		expect(pageFirst).toBe("aurora-root-panel-1");
		expect(session.renderToString()).toContain('id="session-42-panel-1"');
	});
});
