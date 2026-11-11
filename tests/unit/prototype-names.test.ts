// @vitest-environment node
/**
 * A route or cookie name can come from data — a `data-route` attribute, a
 * config value, a request. Looked up through the prototype chain, a name like
 * `constructor` found `Object` and failed as a value, instead of reading as
 * absent.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cookie, setCookieStore } from "../../src/browser.js";
import { setRouteManifest, urlFor } from "../../src/url.js";

const INHERITED = ["constructor", "toString", "__proto__", "hasOwnProperty"];

afterEach(() => {
	setRouteManifest({});
	setCookieStore({});
});

describe("aurora > names that the prototype chain answers", () => {
	it("are unknown routes, with the error a caller branches on", () => {
		setRouteManifest({ home: "/" });
		for (const name of INHERITED) {
			expect(() => urlFor(name)).toThrowError(
				expect.objectContaining({ code: "E_AURORA_UNKNOWN_ROUTE" }),
			);
		}
		expect(urlFor("home")).toBe("/");
	});

	it("are absent cookies during SSR", () => {
		setCookieStore({ theme: "dark" });
		for (const name of INHERITED) expect(cookie.get(name)).toBeNull();
		expect(cookie.get("theme")).toBe("dark");
	});
});
