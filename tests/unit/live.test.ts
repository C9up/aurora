/**
 * Live components (Stage 1, transport-agnostic core) — server-resident reactive
 * state turned into precise per-slot patches. Covers dispatch→patch, push/pull
 * models, fine-grained precision, shared state across sessions, the
 * patch-is-O(changed) measurement, and disposal.
 */
import { describe, expect, it } from "vitest";
import {
	html,
	type LiveComponentDefinition,
	mountLiveSession,
	signal,
} from "../../src/index.js";

describe("aurora > live components (core)", () => {
	it("renders the initial HTML server-side", () => {
		const session = mountLiveSession(() => ({
			view: html`<button>Count: ${signal(0)}</button>`,
		}));
		expect(session.renderToString()).toContain("Count: 0");
		session.dispose();
	});

	it("dispatch runs a handler that mutates state → precise patch (pull)", () => {
		const count = signal(0);
		const def: LiveComponentDefinition = {
			view: html`<button>Count: ${count}</button>`,
			handlers: { increment: () => count(count() + 1) },
		};
		const session = mountLiveSession(() => def);

		session.dispatch("increment");
		expect(session.drainPatches()).toEqual([{ slot: 0, value: "1" }]);
		session.dispatch("increment");
		expect(session.drainPatches()).toEqual([{ slot: 0, value: "2" }]);
		// Draining again with no change → empty.
		expect(session.drainPatches()).toEqual([]);
		session.dispose();
	});

	it("fine-grained: a signal change patches ONLY its slot", () => {
		const name = signal("Ada");
		const count = signal(0);
		const session = mountLiveSession(() => ({
			view: html`<span>${name}</span><b>${count}</b>`,
			handlers: { rename: () => name("Bob") },
		}));
		session.dispatch("rename");
		expect(session.drainPatches()).toEqual([{ slot: 0, value: "Bob" }]);
		session.dispose();
	});

	it("a derived slot patches with its recomputed value", () => {
		const count = signal(2);
		const session = mountLiveSession(() => ({
			view: html`<p>${count}</p><p>${() => count() * 2}</p>`,
			handlers: { inc: () => count(count() + 1) },
		}));
		session.dispatch("inc"); // count 2 → 3
		expect(session.drainPatches()).toEqual([
			{ slot: 0, value: "3" },
			{ slot: 1, value: "6" },
		]);
		session.dispose();
	});

	it("onPatch push model fires with the batch", async () => {
		const count = signal(0);
		const session = mountLiveSession(() => ({
			view: html`<b>${count}</b>`,
			handlers: { inc: () => count(count() + 1) },
		}));
		const received: number[] = [];
		session.onPatch((patch) => received.push(patch.length));
		session.dispatch("inc");
		expect(received).toEqual([1]);
		session.dispose();
	});

	it("SHARED state: one mutation produces a patch in every session", () => {
		const online = signal(1); // created OUTSIDE the factory → shared
		const make = () =>
			mountLiveSession(() => ({
				view: html`<span class="presence">${online} online</span>`,
			}));
		const alice = make();
		const bob = make();

		online(online() + 1); // shared mutation, server-side

		expect(alice.drainPatches()).toEqual([{ slot: 0, value: "2" }]);
		expect(bob.drainPatches()).toEqual([{ slot: 0, value: "2" }]);
		alice.dispose();
		bob.dispose();
	});

	it("patch is O(changed data), not O(component size)", () => {
		const count = signal(0);
		const name = signal("Ada");
		const session = mountLiveSession(() => ({
			view: html`<article class="card card--elevated">
				<header><h1 class="title">Hello, ${name}!</h1><p>Welcome back.</p></header>
				<section><dl><dt>Clicks</dt><dd>Count: ${count}</dd></dl></section>
				<footer><button class="btn">Increment</button><small>Server state.</small></footer>
			</article>`,
			handlers: { inc: () => count(count() + 1) },
		}));
		const fullBytes = Buffer.byteLength(session.renderToString());
		session.dispatch("inc");
		const patchBytes = Buffer.byteLength(JSON.stringify(session.drainPatches()));
		expect(patchBytes).toBeLessThan(fullBytes * 0.15);
		session.dispose();
	});

	it("dispose stops tracking — later mutations produce no patch", () => {
		const count = signal(0);
		const session = mountLiveSession(() => ({
			view: html`<b>${count}</b>`,
			handlers: { inc: () => count(count() + 1) },
		}));
		session.dispose();
		count(5);
		expect(session.drainPatches()).toEqual([]);
	});
});
