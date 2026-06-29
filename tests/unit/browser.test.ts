import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	back,
	booleanCookie,
	clipboard,
	cookie,
	cookieSignal,
	cookieState,
	forward,
	getCookieStore,
	hash,
	jsonCookie,
	mediaQuery,
	navigate,
	online,
	persistedSignal,
	queryParam,
	redirect,
	reload,
	replace,
	session,
	setCookieStore,
	share,
	storage,
	visibility,
	WebStorage,
	windowSize,
} from "../../src/browser.js";

/** Map-backed Storage stub mirroring the Web Storage API. */
function makeStorageStub(): Storage {
	const store = new Map<string, string>();
	return {
		get length() {
			return store.size;
		},
		key: (i: number) => [...store.keys()][i] ?? null,
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => {
			store.set(k, v);
		},
		removeItem: (k: string) => {
			store.delete(k);
		},
		clear: () => store.clear(),
	} as Storage;
}

describe("aurora > browser > navigation", () => {
	it("redirect sets window.location.href", () => {
		const loc = { href: "", replace: vi.fn(), reload: vi.fn() };
		vi.stubGlobal("window", { location: loc });
		redirect("/dashboard");
		expect(loc.href).toBe("/dashboard");
		vi.unstubAllGlobals();
	});

	it("replace + reload delegate to window.location", () => {
		const loc = { href: "", replace: vi.fn(), reload: vi.fn() };
		vi.stubGlobal("window", { location: loc });
		replace("/login");
		reload();
		expect(loc.replace).toHaveBeenCalledWith("/login");
		expect(loc.reload).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});

	it("is a no-op when window is undefined (SSR)", () => {
		vi.stubGlobal("window", undefined);
		expect(() => {
			redirect("/x");
			replace("/x");
			reload();
		}).not.toThrow();
		vi.unstubAllGlobals();
	});
});

describe("aurora > browser > storage", () => {
	beforeEach(() => {
		const store = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, v),
			removeItem: (k: string) => store.delete(k),
			clear: () => store.clear(),
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it("get/set round-trip a raw string (no JSON wrapping)", () => {
		// The token case: a string is stored verbatim, like native localStorage —
		// no surrounding JSON quotes to strip on the way out.
		storage.set("token", "eyJ.a.b");
		expect(storage.get("token")).toBe("eyJ.a.b");
		expect(localStorage.getItem("token")).toBe("eyJ.a.b");
	});

	it("getJSON/setJSON round-trip a structured value", () => {
		storage.setJSON("user", { id: 1, name: "Ada" });
		expect(storage.getJSON<{ id: number; name: string }>("user")).toEqual({
			id: 1,
			name: "Ada",
		});
	});

	it("get/getJSON return null on a miss; getJSON also on malformed JSON", () => {
		expect(storage.get("nope")).toBeNull();
		expect(storage.getJSON("nope")).toBeNull();
		localStorage.setItem("bad", "{not json");
		expect(storage.getJSON("bad")).toBeNull();
		// get() is a pass-through — it returns the raw string, never null-on-parse.
		expect(storage.get("bad")).toBe("{not json");
	});

	it("remove + clear work", () => {
		storage.set("a", "1");
		storage.set("b", "2");
		storage.remove("a");
		expect(storage.get("a")).toBeNull();
		expect(storage.get("b")).toBe("2");
		storage.clear();
		expect(storage.get("b")).toBeNull();
	});

	it("reads return null when localStorage is undefined (SSR)", () => {
		vi.stubGlobal("localStorage", undefined);
		expect(storage.get("x")).toBeNull();
		expect(() => storage.set("x", "1")).not.toThrow();
	});
});

describe("aurora > browser > WebStorage class", () => {
	beforeEach(() => {
		vi.stubGlobal("localStorage", makeStorageStub());
		vi.stubGlobal("sessionStorage", makeStorageStub());
	});
	afterEach(() => vi.unstubAllGlobals());

	it("namespaces keys by prefix and keeps stores isolated", () => {
		const a = new WebStorage({ prefix: "a:" });
		const b = new WebStorage({ prefix: "b:" });
		a.set("k", "1");
		b.set("k", "2");
		expect(a.get("k")).toBe("1");
		expect(b.get("k")).toBe("2");
		expect(localStorage.getItem("a:k")).toBe("1");
	});

	it("has() reflects presence", () => {
		const s = new WebStorage();
		expect(s.has("x")).toBe(false);
		s.set("x", "v");
		expect(s.has("x")).toBe(true);
	});

	it("getOrSet computes + persists on a miss, returns cached on a hit", () => {
		const s = new WebStorage();
		const factory = vi.fn(() => "42");
		expect(s.getOrSet("v", factory)).toBe("42");
		expect(s.getOrSet("v", factory)).toBe("42");
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("keys() strips the prefix; clear() is prefix-scoped", () => {
		const s = new WebStorage({ prefix: "app:" });
		s.set("one", "1");
		s.set("two", "2");
		localStorage.setItem("other", "x"); // outside the prefix
		expect(s.keys().sort()).toEqual(["one", "two"]);
		s.clear();
		expect(s.keys()).toEqual([]);
		expect(localStorage.getItem("other")).toBe("x");
	});

	it("session uses sessionStorage, not localStorage", () => {
		session.set("tab", "live");
		expect(sessionStorage.getItem("tab")).toBe("live");
		expect(localStorage.getItem("tab")).toBeNull();
	});

	it("is SSR-safe when window is undefined", () => {
		vi.stubGlobal("window", undefined);
		const s = new WebStorage();
		expect(s.get("x")).toBeNull();
		expect(s.has("x")).toBe(false);
		expect(s.keys()).toEqual([]);
		expect(() => {
			s.set("x", "1");
			s.remove("x");
			s.clear();
		}).not.toThrow();
	});
});

describe("aurora > browser > persistedSignal", () => {
	beforeEach(() => {
		vi.stubGlobal("localStorage", makeStorageStub());
	});
	afterEach(() => vi.unstubAllGlobals());

	it("seeds from initial and persists writes", () => {
		const count = persistedSignal("count", 0);
		expect(count()).toBe(0);
		expect(localStorage.getItem("count")).toBe("0"); // mirrored immediately
		count(5);
		expect(count()).toBe(5);
		expect(localStorage.getItem("count")).toBe("5");
	});

	it("hydrates from an existing stored value over the initial", () => {
		localStorage.setItem("theme", '"dark"');
		const theme = persistedSignal("theme", "light");
		expect(theme()).toBe("dark");
	});

	it("respects a prefix", () => {
		const s = persistedSignal("flag", true, { prefix: "ui:" });
		s(false);
		expect(localStorage.getItem("ui:flag")).toBe("false");
	});

	it("updates live on a cross-tab storage event", () => {
		const count = persistedSignal("count", 1);
		window.dispatchEvent(
			Object.assign(new Event("storage"), { key: "count", newValue: "9" }),
		);
		expect(count()).toBe(9);
	});

	it("ignores storage events for other keys or malformed values", () => {
		const count = persistedSignal("count", 1);
		window.dispatchEvent(
			Object.assign(new Event("storage"), { key: "other", newValue: "9" }),
		);
		window.dispatchEvent(
			Object.assign(new Event("storage"), { key: "count", newValue: "{bad" }),
		);
		expect(count()).toBe(1);
	});
});

describe("aurora > browser > reactive browser signals", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("mediaQuery reflects matches and updates on change", () => {
		const listeners: Array<(e: { matches: boolean }) => void> = [];
		const mql = {
			matches: true,
			addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
				listeners.push(cb);
			},
		};
		vi.stubGlobal("window", { matchMedia: () => mql });
		const dark = mediaQuery("(prefers-color-scheme: dark)");
		expect(dark()).toBe(true);
		for (const cb of listeners) cb({ matches: false });
		expect(dark()).toBe(false);
	});

	it("online tracks navigator.onLine via events", () => {
		let on = true;
		const handlers: Record<string, () => void> = {};
		vi.stubGlobal("navigator", {
			get onLine() {
				return on;
			},
		});
		vi.stubGlobal("window", {
			addEventListener: (ev: string, cb: () => void) => {
				handlers[ev] = cb;
			},
		});
		const live = online();
		expect(live()).toBe(true);
		on = false;
		handlers.offline?.();
		expect(live()).toBe(false);
	});

	it("windowSize tracks the viewport via resize", () => {
		let w = 800;
		let h = 600;
		const handlers: Record<string, () => void> = {};
		vi.stubGlobal("window", {
			get innerWidth() {
				return w;
			},
			get innerHeight() {
				return h;
			},
			addEventListener: (ev: string, cb: () => void) => {
				handlers[ev] = cb;
			},
		});
		const size = windowSize();
		expect(size()).toEqual({ width: 800, height: 600 });
		w = 1024;
		h = 768;
		handlers.resize?.();
		expect(size()).toEqual({ width: 1024, height: 768 });
	});

	it("visibility tracks document.hidden", () => {
		let hidden = false;
		const handlers: Record<string, () => void> = {};
		vi.stubGlobal("document", {
			get hidden() {
				return hidden;
			},
			addEventListener: (ev: string, cb: () => void) => {
				handlers[ev] = cb;
			},
		});
		const vis = visibility();
		expect(vis()).toBe(true);
		hidden = true;
		handlers.visibilitychange?.();
		expect(vis()).toBe(false);
	});

	it("hash tracks location.hash", () => {
		let h = "#a";
		const handlers: Record<string, () => void> = {};
		vi.stubGlobal("window", {
			location: {
				get hash() {
					return h;
				},
			},
			addEventListener: (ev: string, cb: () => void) => {
				handlers[ev] = cb;
			},
		});
		const hsh = hash();
		expect(hsh()).toBe("#a");
		h = "#b";
		handlers.hashchange?.();
		expect(hsh()).toBe("#b");
	});

	it("are SSR-safe with sensible defaults", () => {
		vi.stubGlobal("window", undefined);
		vi.stubGlobal("navigator", undefined);
		vi.stubGlobal("document", undefined);
		expect(mediaQuery("x")()).toBe(false);
		expect(online()()).toBe(true);
		expect(windowSize()()).toEqual({ width: 0, height: 0 });
		expect(visibility()()).toBe(true);
		expect(hash()()).toBe("");
	});
});

describe("aurora > browser > URL / history", () => {
	it("queryParam reads and writes the URL without reload", () => {
		window.history.pushState({}, "", "/p?page=2");
		const page = queryParam("page");
		expect(page()).toBe("2");
		page("3");
		expect(new URLSearchParams(window.location.search).get("page")).toBe("3");
		page(null);
		expect(new URLSearchParams(window.location.search).get("page")).toBeNull();
	});

	it("navigate pushes state and notifies queryParam via popstate", () => {
		window.history.pushState({}, "", "/x");
		const q = queryParam("q");
		expect(q()).toBeNull();
		navigate("/x?q=hello");
		expect(q()).toBe("hello");
	});

	it("back/forward/navigate are SSR no-ops", () => {
		vi.stubGlobal("window", undefined);
		expect(() => {
			back();
			forward();
			navigate("/x");
		}).not.toThrow();
		vi.unstubAllGlobals();
	});
});

describe("aurora > browser > cookie", () => {
	afterEach(() => {
		for (const part of document.cookie.split("; ")) {
			const name = part.split("=")[0];
			if (name) cookie.remove(name);
		}
	});

	it("round-trips a URL-encoded value", () => {
		cookie.set("lang", "fr ça");
		expect(cookie.get("lang")).toBe("fr ça");
	});

	it("remove deletes the cookie", () => {
		cookie.set("tmp", "1");
		cookie.remove("tmp");
		expect(cookie.get("tmp")).toBeNull();
	});

	it("is SSR-safe", () => {
		vi.stubGlobal("document", undefined);
		expect(cookie.get("x")).toBeNull();
		expect(() => {
			cookie.set("x", "1");
			cookie.remove("x");
		}).not.toThrow();
		vi.unstubAllGlobals();
	});
});

describe("aurora > browser > SSR cookie seed", () => {
	afterEach(() => {
		setCookieStore({});
		vi.unstubAllGlobals();
	});

	it("cookie.get reads the seed during SSR (no document)", () => {
		vi.stubGlobal("document", undefined);
		setCookieStore({ sidebar: "1", theme: "dark" });
		expect(cookie.get("sidebar")).toBe("1");
		expect(cookie.get("theme")).toBe("dark");
		expect(cookie.get("absent")).toBeNull();
	});

	it("getCookieStore returns a copy of the seed", () => {
		setCookieStore({ a: "1" });
		const snap = getCookieStore();
		snap.a = "mutated";
		expect(getCookieStore().a).toBe("1");
	});
});

describe("aurora > browser > cookieSignal / cookieState", () => {
	afterEach(() => {
		// Restore a real `document` FIRST — a prior test may have stubbed it to
		// `undefined` (SSR), and the cookie cleanup below needs the real one.
		vi.unstubAllGlobals();
		for (const part of document.cookie.split("; ")) {
			const name = part.split("=")[0];
			if (name) cookie.remove(name);
		}
		setCookieStore({});
	});

	it("seeds from the cookie and persists string writes (browser)", () => {
		cookie.set("locale", "fr");
		const locale = cookieSignal("locale", "en");
		expect(locale()).toBe("fr");
		locale("de");
		expect(locale()).toBe("de");
		expect(cookie.get("locale")).toBe("de");
	});

	it("falls back to the initial value when the cookie is absent", () => {
		const locale = cookieSignal("locale", "en");
		expect(locale()).toBe("en");
	});

	it("seeds a cookieSignal from the SSR seed (no document)", () => {
		vi.stubGlobal("document", undefined);
		setCookieStore({ theme: "dark" });
		expect(cookieSignal("theme", "light")()).toBe("dark");
	});

	it("booleanCookie round-trips through a signal", () => {
		cookie.set("collapsed", "1");
		const collapsed = cookieState("collapsed", false, booleanCookie);
		expect(collapsed()).toBe(true);
		collapsed(false);
		expect(collapsed()).toBe(false);
		expect(cookie.get("collapsed")).toBe("0");
	});

	it("jsonCookie round-trips an object and falls back when malformed", () => {
		const prefs = cookieState(
			"prefs",
			{ open: true },
			jsonCookie({ open: true }),
		);
		prefs({ open: false });
		expect(cookie.get("prefs")).toBe('{"open":false}');
		// A tampered cookie parses to the fallback instead of throwing.
		cookie.set("prefs", "{not json");
		expect(
			cookieState("prefs", { open: true }, jsonCookie({ open: true }))(),
		).toEqual({
			open: true,
		});
	});
});

describe("aurora > browser > clipboard + share", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("copy writes via navigator.clipboard", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		expect(await clipboard.copy("hi")).toBe(true);
		expect(writeText).toHaveBeenCalledWith("hi");
	});

	it("copy returns false when unavailable", async () => {
		vi.stubGlobal("navigator", {});
		expect(await clipboard.copy("x")).toBe(false);
	});

	it("read returns text, or null when unavailable", async () => {
		vi.stubGlobal("navigator", {
			clipboard: { readText: () => Promise.resolve("yo") },
		});
		expect(await clipboard.read()).toBe("yo");
		vi.stubGlobal("navigator", {});
		expect(await clipboard.read()).toBeNull();
	});

	it("share invokes navigator.share; false when unsupported or cancelled", async () => {
		const fn = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { share: fn });
		expect(await share({ title: "t" })).toBe(true);
		expect(fn).toHaveBeenCalledWith({ title: "t" });

		vi.stubGlobal("navigator", {
			share: () => Promise.reject(new Error("cancel")),
		});
		expect(await share({ title: "t" })).toBe(false);

		vi.stubGlobal("navigator", {});
		expect(await share({})).toBe(false);
	});
});
