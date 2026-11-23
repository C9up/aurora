import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors, urlFor } from "../../src/index.js";
import { Pages, errors as serverErrors } from "../../src/server.js";

describe("aurora > errors", () => {
	// A message is prose and is free to improve; a code is a contract. These
	// assert the contract, so a later reword cannot silently break a caller's
	// branch.

	it("carries a code a caller can branch on, without matching the message", async () => {
		const pages = new Pages({ root: "/nonexistent-root" });
		const error = await pages.resolve("Ghost").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(errors.E_AURORA_PAGE_NOT_FOUND);
		expect(error).toMatchObject({ code: "E_AURORA_PAGE_NOT_FOUND" });
	});

	it("distinguishes an illegal name from a page that is merely absent", async () => {
		const pages = new Pages({ root: "/nonexistent-root" });
		const traversal = await pages
			.resolve("../../etc/passwd")
			.catch((e: unknown) => e);
		expect(traversal).toMatchObject({ code: "E_AURORA_ILLEGAL_PAGE_NAME" });
	});

	it("codes the two urlFor failures apart", () => {
		expect(() => urlFor("nope")).toThrow(
			expect.objectContaining({ code: "E_AURORA_UNKNOWN_ROUTE" }),
		);
	});

	it("exports them as one namespace, from the client and the server entry", () => {
		expect(serverErrors).toBe(errors);
		const error = new errors.E_AURORA_INTERNAL(["boom"]);
		expect(error).toBeInstanceOf(Exception);
		expect(error.status).toBe(500);
		expect(error.message).toBe("[aurora] boom");
	});

	it("maps a refused live session to 503", () => {
		const error = new errors.E_AURORA_LIVE_SESSION_LIMIT([3, "Counter"]);
		expect(error.status).toBe(503);
		expect(error.code).toBe("E_AURORA_LIVE_SESSION_LIMIT");
	});

	it("passes `cause` through to the standard Error option", () => {
		const root = new Error("underlying");
		const wrapped = new errors.E_AURORA_INTERNAL(["boom"], { cause: root });
		expect(wrapped.cause).toBe(root);
	});
});
