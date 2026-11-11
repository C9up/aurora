/**
 * A component's setup may create effects and memos, which subscribe to what
 * they read at once. The client disposes them at unmount; the server has no
 * unmount, so `renderToString` has to be the end of their life — otherwise a
 * signal that outlives the request (a module-level store, a service's state)
 * gains one dead observer per render, each keeping that request's tree alive.
 */
import { describe, expect, it } from "vitest";
import {
	component,
	effect,
	html,
	memo,
	mountLiveSession,
	onUnmount,
	renderToString,
	signal,
} from "../../src/index.js";
import { observerCount } from "../../src/reactive.js";

const theme = signal("light");

const Label = component(() => {
	const label = memo(() => `theme:${theme()}`);
	effect(() => {
		theme();
	});
	return html`<span>${label}</span>`;
});

describe("aurora > SSR > disposal of what a setup created", () => {
	it("leaves no observer on a shared signal after many renders", () => {
		expect(observerCount(theme)).toBe(0);
		for (let i = 0; i < 100; i++) {
			expect(renderToString(Label())).toContain("theme:light");
		}
		expect(observerCount(theme)).toBe(0);
	});

	it("disposes nested components, those built inside an accessor, and those another component returns", () => {
		const Wrapper = component(() => Label());
		const Page = component(() => {
			const local = memo(() => theme().length);
			return html`<main>${Label()}${() => Label()}${[Label(), Wrapper()]}<i>${local}</i></main>`;
		});
		for (let i = 0; i < 10; i++) renderToString(Page());
		expect(observerCount(theme)).toBe(0);
	});

	it("disposes even when the render throws", () => {
		const Broken = component(() => {
			memo(() => theme());
			return html`<a ${"onclick"}="x">`;
		});
		expect(() => renderToString(Broken())).toThrow();
		expect(observerCount(theme)).toBe(0);
	});

	it("ends what a setup began when the setup itself throws", () => {
		const Failing = component(() => {
			memo(() => theme());
			throw new Error("setup failed");
		});
		expect(() => Failing()).toThrow("setup failed");
		expect(observerCount(theme)).toBe(0);
	});

	it("leaves onUnmount alone: nothing mounted on the server", () => {
		let unmounted = 0;
		const Hooked = component(() => {
			onUnmount(() => {
				unmounted += 1;
			});
			return html`<p>x</p>`;
		});
		renderToString(Hooked());
		expect(unmounted).toBe(0);
	});

	it("keeps a live session's components running until the session ends", () => {
		const session = mountLiveSession(() => ({
			view: html`<div>${Label()}</div>`,
			handlers: { dark: () => theme("dark") },
		}));
		session.renderToString();
		session.renderToString();
		const watched = observerCount(theme);
		expect(watched).toBeGreaterThan(0);
		session.dispatch("dark");
		expect(session.renderToString()).toContain("theme:dark");
		session.dispose();
		expect(observerCount(theme)).toBe(0);
		theme("light");
	});
});
