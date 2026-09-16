import { describe, expect, it } from "vitest";
import { AuroraError, urlFor } from "../../src/index.js";
import { Pages } from "../../src/server.js";

describe("aurora > errors", () => {
	// A message is prose and is free to improve; a code is a contract. These
	// assert the contract, so a later reword cannot silently break a caller's
	// branch.

	it("carries a code a caller can branch on, without matching the message", async () => {
		const pages = new Pages({ root: "/nonexistent-root" });
		const error = await pages.resolve("Ghost").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AuroraError);
		expect((error as AuroraError).code).toBe("E_AURORA_PAGE_NOT_FOUND");
	});

	it("distinguishes an illegal name from a page that is merely absent", async () => {
		const pages = new Pages({ root: "/nonexistent-root" });
		const traversal = await pages
			.resolve("../../etc/passwd")
			.catch((e: unknown) => e);
		expect((traversal as AuroraError).code).toBe("E_AURORA_ILLEGAL_PAGE_NAME");
	});

	it("codes the two urlFor failures apart", () => {
		let unknown: unknown;
		try {
			urlFor("nope");
		} catch (err) {
			unknown = err;
		}
		expect((unknown as AuroraError).code).toBe("E_AURORA_UNKNOWN_ROUTE");
	});

	it("is catchable as one class across the whole package", () => {
		// The point of a base class: `catch (e) { if (e instanceof AuroraError) }`
		// works for every failure aurora raises, client-side ones included.
		const error = new AuroraError("E_AURORA_INTERNAL", "boom");
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("AuroraError");
	});

	it("passes `cause` through to the standard Error option", () => {
		const root = new Error("underlying");
		const wrapped = new AuroraError("E_AURORA_INTERNAL", "boom", {
			cause: root,
		});
		expect(wrapped.cause).toBe(root);
	});
});
