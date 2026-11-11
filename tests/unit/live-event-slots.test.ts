/**
 * A live view is an ordinary `html` template, and the client hydrates the same
 * factory — so it can carry client listeners. The session's patch tracker must
 * leave those slots alone: an `@event` value is a handler, not a reactive
 * accessor, and calling it at mount ran it before any interaction (and, for a
 * handler that reads and writes the same signal, recursed until the stack
 * overflowed).
 */
import { describe, expect, it } from "vitest";
import { html, mountLiveSession, signal } from "../../src/index.js";

describe("aurora > live session > event slots", () => {
	it("never calls an @event handler at mount, whatever quoting the template uses", () => {
		let calls = 0;
		const handler = (): void => {
			calls += 1;
		};
		const views = [
			() => html`<button @click=${handler}>x</button>`,
			() => html`<button @click="${handler}">x</button>`,
			() => html`<button @click='${handler}'>x</button>`,
			() => html`<button
				@pointer-down=${handler}>x</button>`,
		];
		for (const view of views) {
			const session = mountLiveSession(() => ({ view: view() }));
			session.renderToString();
			session.dispose();
		}
		expect(calls).toBe(0);
	});

	it("mounts a view whose handler reads and writes the signal it shows", () => {
		const count = signal(0);
		const increment = (): void => count(count() + 1);
		const session = mountLiveSession(() => ({
			view: html`<button @click=${increment}>${count}</button>`,
			handlers: { increment },
		}));
		expect(count()).toBe(0);
		// The text slot after the listener is still live.
		session.dispatch("increment");
		expect(session.drainPatches()).toEqual([{ slot: 1, value: "1" }]);
		session.dispose();
	});

	it("keeps patching the attribute, boolean and property slots around a listener", () => {
		const label = signal("a");
		const busy = signal(false);
		const text = signal("x");
		const session = mountLiveSession(() => ({
			view: html`<input class=${label} ?disabled=${busy} @input=${() => text("never")} .value=${text}>`,
			handlers: {
				change: () => {
					label("b");
					busy(true);
					text("y");
				},
			},
		}));
		expect(text()).toBe("x");
		session.dispatch("change");
		expect(session.drainPatches()).toEqual([
			{ slot: 0, value: "b" },
			{ slot: 1, value: "true" },
			{ slot: 3, value: "y" },
		]);
		session.dispose();
	});
});
