/**
 * The helpers that create signals notify only on a real change.
 *
 * A form rebuilt its error and touched maps on every call and wrote its values
 * and its errors as two updates; a live session sent a patch for a slot whose
 * text had not changed; a live client applied a patch one signal at a time;
 * `windowSize` notified on a resize that left the size as it was;
 * `persistedSignal` turned another tab's identical write into a new object;
 * and the listeners of `queryParam` and `persistedSignal` outlived the
 * component that created them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	command,
	component,
	effect,
	form,
	html,
	type LiveClientTransport,
	liveClient,
	mountLiveSession,
	persistedSignal,
	queryParam,
	render,
	renderToString,
	type SlotPatch,
	signal,
	windowSize,
} from "../../src/index.js";

beforeEach(() => {
	// The test environment's own Storage is not complete; a Map stands in.
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => store.set(k, v),
		removeItem: (k: string) => store.delete(k),
		clear: () => store.clear(),
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("form", () => {
	it("an edit that clears a field's error is one update", () => {
		const f = form({
			initial: { email: "" },
			submit: async () => {},
			validate: (v) => (v.email ? {} : { email: "required" }),
		});
		f.validate();
		let runs = 0;
		effect(() => {
			f.values();
			f.errors();
			runs++;
		});
		runs = 0;
		f.set("email", "a@b.c");
		expect(runs).toBe(1);
	});

	it("validating again with the same outcome notifies nothing", () => {
		const f = form({
			initial: { email: "" },
			submit: async () => {},
			validate: (v) => (v.email ? {} : { email: "required" }),
		});
		f.validate();
		let runs = 0;
		effect(() => {
			f.errors();
			runs++;
		});
		runs = 0;
		f.validate();
		f.setErrors({});
		expect(runs).toBe(0);
	});

	it("setting a field to the value it holds notifies nothing", () => {
		const f = form({ initial: { name: "Ada" }, submit: async () => {} });
		let runs = 0;
		effect(() => {
			f.values();
			runs++;
		});
		runs = 0;
		f.set("name", "Ada");
		expect(runs).toBe(0);
	});
});

describe("command", () => {
	it("starting a run is one update for what reads loading and error", async () => {
		let fail = true;
		const flaky = command(async () => {
			if (fail) throw new Error("no");
		});
		await flaky.run();
		let runs = 0;
		effect(() => {
			flaky.loading();
			flaky.error();
			runs++;
		});
		runs = 0;
		fail = false;
		const pending = flaky.run();
		expect(runs).toBe(1);
		await pending;
	});
});

describe("live session", () => {
	it("sends no patch for a slot whose text did not change", () => {
		const n = signal(1);
		const session = mountLiveSession(() => ({
			view: html`<p>${() => (n() > 5 ? "big" : "small")}</p>`,
			handlers: { bump: () => n(n() + 1) },
		}));
		session.renderToString();
		session.dispatch("bump");
		expect(session.drainPatches()).toEqual([]);
		session.dispose();
	});

	it("sends no patch for a slot that changed and came back before the flush", () => {
		const n = signal(1);
		const session = mountLiveSession(() => ({
			view: html`<p>${n}</p>`,
			handlers: {
				wobble: () => {
					n(2);
					n(1);
				},
			},
		}));
		session.renderToString();
		session.dispatch("wobble");
		expect(session.drainPatches()).toEqual([]);
		session.dispose();
	});
});

describe("live client", () => {
	it("applies a patch of several slots as one update", () => {
		const a = signal("1");
		const b = signal("1");
		let runs = 0;
		const view = () =>
			html`<p>${a}${b}</p><i>${() => {
				runs++;
				return `${a()}+${b()}`;
			}}</i>`;
		const container = document.createElement("div");
		container.innerHTML = renderToString(view());
		let deliver: (patch: SlotPatch[]) => void = () => {};
		const transport: LiveClientTransport = {
			subscribe(_channel, handler) {
				deliver = handler;
				return () => {};
			},
			post() {},
		};
		const dispose = liveClient({
			container,
			factory: view,
			mount: { id: "s", channel: "c" },
			transport,
		});
		runs = 0;
		deliver([
			{ slot: 0, value: "2" },
			{ slot: 1, value: "3" },
		]);
		expect(runs).toBe(1);
		expect(container.querySelector("i")?.textContent).toBe("2+3");
		dispose();
	});
});

describe("browser signals", () => {
	it("windowSize does not notify on a resize that kept the size", () => {
		const size = windowSize();
		let runs = 0;
		effect(() => {
			size();
			runs++;
		});
		runs = 0;
		window.dispatchEvent(new Event("resize"));
		expect(runs).toBe(0);
	});

	it("persistedSignal ignores another tab's write of the value it holds", () => {
		const prefs = persistedSignal("prefs", { dense: true });
		let runs = 0;
		effect(() => {
			prefs();
			runs++;
		});
		runs = 0;
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: "prefs",
				newValue: JSON.stringify({ dense: true }),
			}),
		);
		expect(runs).toBe(0);
	});

	it("queryParam and persistedSignal remove their listeners with the component that made them", () => {
		const removed: string[] = [];
		const original = window.removeEventListener.bind(window);
		vi.spyOn(window, "removeEventListener").mockImplementation(
			(type, listener, options) => {
				removed.push(type);
				original(type, listener, options);
			},
		);
		const Probe = component(() => {
			queryParam("tab");
			persistedSignal("p", 1);
			return html`<i></i>`;
		});
		const host = document.createElement("div");
		const dispose = render(Probe(), host);
		dispose();
		expect(removed.sort()).toEqual(["popstate", "storage"]);
	});
});
