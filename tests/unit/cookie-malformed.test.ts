import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cookie,
	cookieSignal,
	cookieState,
	jsonCookie,
} from "../../src/index.js";

/**
 * A cookie whose value is not valid percent-encoding — which a sibling
 * subdomain or any script can set — made every reader throw URIError, and the
 * component reading it failed to hydrate. It reads as absent instead.
 */

function clear(): void {
	for (const part of document.cookie.split("; ")) {
		const name = part.split("=")[0];
		if (name) document.cookie = `${name}=; path=/; max-age=0`;
	}
}

afterEach(clear);

describe("aurora > cookie > malformed values", () => {
	it("reads a value with a broken escape as absent", () => {
		document.cookie = "sidebar=%E0%A4%A; path=/";
		expect(() => cookie.get("sidebar")).not.toThrow();
		expect(cookie.get("sidebar")).toBeNull();
	});

	it("still decodes a valid encoded value", () => {
		document.cookie = `theme=${encodeURIComponent("dark mode/é")}; path=/`;
		expect(cookie.get("theme")).toBe("dark mode/é");
	});

	it("gives cookieSignal its initial value", () => {
		document.cookie = "sidebar=%E0%A4%A; path=/";
		expect(cookieSignal("sidebar", "open")()).toBe("open");
	});

	it("gives cookieState with jsonCookie its initial value", () => {
		document.cookie = "prefs=%7B%22a%22%3A1%E0; path=/";
		expect(cookieState("prefs", { a: 0 }, jsonCookie({ a: -1 }))()).toEqual({
			a: 0,
		});
	});

	it("falls through to a later cookie of the same name that decodes", () => {
		// Two cookies of one name — a sibling subdomain's and the page's own —
		// arrive together; the broken one must not hide the other.
		const read = vi
			.spyOn(document, "cookie", "get")
			.mockReturnValue("dup=%E0%A4%A; dup=ok");
		expect(cookie.get("dup")).toBe("ok");
		read.mockRestore();
	});
});
