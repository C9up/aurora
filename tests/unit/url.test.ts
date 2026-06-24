import { beforeEach, describe, expect, it } from "vitest";
import { getRouteManifest, setRouteManifest, urlFor } from "../../src/url.js";

beforeEach(() => {
	setRouteManifest({
		"auth.login": "/login",
		"users.show": "/users/:id",
		"users.posts": "/users/:userId/posts/:postId",
		"posts.show": "/posts/:id/:slug?",
		search: "/search",
	});
});

describe("aurora > urlFor", () => {
	it("returns a static route's path", () => {
		expect(urlFor("auth.login")).toBe("/login");
	});

	it("fills a single param", () => {
		expect(urlFor("users.show", { id: 42 })).toBe("/users/42");
		expect(urlFor("users.show", { id: "abc" })).toBe("/users/abc");
	});

	it("fills multiple params without cross-corruption", () => {
		expect(urlFor("users.posts", { userId: 7, postId: 99 })).toBe(
			"/users/7/posts/99",
		);
	});

	it("drops an unprovided optional segment", () => {
		expect(urlFor("posts.show", { id: 5 })).toBe("/posts/5");
		expect(urlFor("posts.show", { id: 5, slug: "hello" })).toBe(
			"/posts/5/hello",
		);
	});

	it("appends a query string", () => {
		expect(urlFor("search", {}, { q: "ream", p: 2 })).toBe(
			"/search?q=ream&p=2",
		);
		expect(urlFor("users.show", { id: 1 }, { tab: "posts" })).toBe(
			"/users/1?tab=posts",
		);
	});

	it("url-encodes param and query values", () => {
		expect(urlFor("users.show", { id: "a b/c" })).toBe("/users/a%20b%2Fc");
		expect(urlFor("search", {}, { q: "a&b" })).toBe("/search?q=a%26b");
	});

	it("throws on a missing required param", () => {
		expect(() => urlFor("users.show")).toThrow(/missing params.*:id/);
		expect(() => urlFor("users.posts", { userId: 1 })).toThrow(
			/missing params.*:postId/,
		);
	});

	it("throws on an unknown route name", () => {
		expect(() => urlFor("nope")).toThrow(/unknown route 'nope'/);
	});
});

describe("aurora > setRouteManifest / getRouteManifest", () => {
	it("replaces the manifest and exposes a copy", () => {
		setRouteManifest({ home: "/" });
		expect(getRouteManifest()).toEqual({ home: "/" });
		expect(urlFor("home")).toBe("/");
		// users.show from the previous manifest is gone.
		expect(() => urlFor("users.show", { id: 1 })).toThrow(/unknown route/);
	});

	it("returns a defensive copy (mutation does not leak)", () => {
		const m = getRouteManifest();
		m.injected = "/evil";
		expect(() => urlFor("injected")).toThrow(/unknown route/);
	});
});
