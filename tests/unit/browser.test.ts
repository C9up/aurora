import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redirect, reload, replace, storage } from "../../src/browser.js";

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

	it("round-trips a JSON value", () => {
		storage.set("user", { id: 1, name: "Ada" });
		expect(storage.get<{ id: number; name: string }>("user")).toEqual({
			id: 1,
			name: "Ada",
		});
	});

	it("returns null for a missing key or malformed JSON", () => {
		expect(storage.get("nope")).toBeNull();
		localStorage.setItem("bad", "{not json");
		expect(storage.get("bad")).toBeNull();
	});

	it("remove + clear work", () => {
		storage.set("a", 1);
		storage.set("b", 2);
		storage.remove("a");
		expect(storage.get("a")).toBeNull();
		expect(storage.get("b")).toBe(2);
		storage.clear();
		expect(storage.get("b")).toBeNull();
	});

	it("reads return null when localStorage is undefined (SSR)", () => {
		vi.stubGlobal("localStorage", undefined);
		expect(storage.get("x")).toBeNull();
		expect(() => storage.set("x", 1)).not.toThrow();
	});
});
