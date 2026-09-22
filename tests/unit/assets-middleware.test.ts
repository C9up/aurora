/**
 * `assetsMiddleware` — what never reaches the application.
 *
 * The bug it exists to close: aurora's pages are unbundled, so one page load
 * is dozens of `.js` requests, and as ROUTES they each ran the application's
 * middleware — ninety-six `SELECT * FROM users` for bytes identical for every
 * visitor. So the matching happens at the SERVER tier and short-circuits.
 *
 * Which makes the passthrough half just as load-bearing: a middleware that
 * answers ahead of routing must claim URLs it owns and nothing else.
 */

import { describe, expect, it } from "vitest";
import {
	type AssetMount,
	type AssetsHost,
	assetsMiddleware,
} from "../../src/server/assetsMiddleware.js";
import type { AssetsResponse } from "../../src/server/serveAssets.js";

/** A mount that records the wildcard it was handed instead of touching disk. */
function spyMount(prefix: string, seen: string[]): AssetMount {
	return {
		prefix,
		handler: async (ctx) => {
			seen.push(`${prefix} → ${String(ctx.request.param("*"))}`);
		},
	};
}

function hostFor(url: string, method?: string): AssetsHost {
	const response: AssetsResponse = {
		status: () => response,
		header: () => response,
		send: () => {},
	};
	return {
		request: {
			url: () => url,
			...(method === undefined ? {} : { method: () => method }),
			header: () => undefined,
		},
		response,
	};
}

async function run(
	mounts: AssetMount[],
	url: string,
	method?: string,
): Promise<{ seen: string[]; reachedApp: boolean }> {
	const seen: string[] = [];
	const built = mounts.map((mount) => spyMount(mount.prefix, seen));
	let reachedApp = false;
	await assetsMiddleware(built)(hostFor(url, method), async () => {
		reachedApp = true;
	});
	return { seen, reachedApp };
}

const MOUNTS: AssetMount[] = [
	{ prefix: "/__assets/aurora", handler: async () => {} },
	{ prefix: "/__assets/pages", handler: async () => {} },
	{ prefix: "/__assets/comet/dist", handler: async () => {} },
];

describe("aurora > assetsMiddleware", () => {
	it("answers a mounted path and never calls next()", async () => {
		const { seen, reachedApp } = await run(
			MOUNTS,
			"/__assets/pages/Dashboard.js",
		);
		expect(seen).toEqual(["/__assets/pages → Dashboard.js"]);
		// The point of the whole file: the application does not see this.
		expect(reachedApp).toBe(false);
	});

	it("hands the handler everything under the prefix, nested included", async () => {
		// `serveAssets` reads the wildcard through `param('*')` — a ROUTER
		// concept. Synthesising it here is what lets that handler stay exactly as
		// it was, usable as a plain route by a host that prefers one.
		const { seen } = await run(MOUNTS, "/__assets/aurora/nested/deep/mod.js");
		expect(seen).toEqual(["/__assets/aurora → nested/deep/mod.js"]);
	});

	it("matches the LONGEST prefix, whatever order they were listed in", async () => {
		// Registered aurora-first, but `/__assets/comet/dist` must win over a
		// mount at `/__assets/comet` — otherwise which one serves depends on the
		// order the manager happened to build them in.
		const { seen } = await run(
			[
				{ prefix: "/__assets/comet", handler: async () => {} },
				{ prefix: "/__assets/comet/dist", handler: async () => {} },
			],
			"/__assets/comet/dist/index.js",
		);
		expect(seen).toEqual(["/__assets/comet/dist → index.js"]);
	});

	it("ignores the query string", async () => {
		// aurora appends `?v=…` to bust the module cache in dev; a cache-buster
		// must not defeat the prefix match nor change which file is read.
		const { seen, reachedApp } = await run(
			MOUNTS,
			"/__assets/pages/Dashboard.js?v=17",
		);
		expect(seen).toEqual(["/__assets/pages → Dashboard.js"]);
		expect(reachedApp).toBe(false);
	});

	it("passes through a path that only looks like a mount", async () => {
		// `/__assets/pagesomething` shares a prefix with `/__assets/pages` but is
		// not under it — the separator is part of the match.
		expect((await run(MOUNTS, "/__assets/pagesomething.js")).reachedApp).toBe(
			true,
		);
		// The bare mount point is not a file either.
		expect((await run(MOUNTS, "/__assets/pages")).reachedApp).toBe(true);
		expect((await run(MOUNTS, "/dashboard")).reachedApp).toBe(true);
	});

	it("serves HEAD, and leaves every write method to the application", async () => {
		expect((await run(MOUNTS, "/__assets/pages/x.js", "head")).seen).toEqual([
			"/__assets/pages → x.js",
		]);
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			// A POST to an asset URL is not a file read. Answering it here would
			// hide it from the application — including from CSRF protection.
			expect(
				(await run(MOUNTS, "/__assets/pages/x.js", method)).reachedApp,
			).toBe(true);
		}
	});

	it("assumes GET from a host that does not expose the method", async () => {
		// Duck-typed on purpose: a host with no `method()` still gets its assets.
		const { seen } = await run(MOUNTS, "/__assets/pages/x.js", undefined);
		expect(seen).toEqual(["/__assets/pages → x.js"]);
	});

	it("passes everything through when there is nothing mounted", async () => {
		expect((await run([], "/__assets/pages/x.js")).reachedApp).toBe(true);
	});
});
