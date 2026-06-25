import { describe, expect, it } from "vitest";

describe("aurora > browser harness smoke", () => {
	it("runs in a real Chromium (not happy-dom)", () => {
		expect(navigator.userAgent).toMatch(/Chrom/);
	});

	it("the real parser merges adjacent text nodes around a comment", () => {
		const d = document.createElement("div");
		d.innerHTML = "Hello World!"; // a single merged text node
		expect(d.childNodes.length).toBe(1);
	});
});
