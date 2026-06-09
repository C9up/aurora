import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AssetsHttpContext, AssetsResponse } from "../../src/server.js";
import { serveAssets } from "../../src/server.js";

const FIXTURES_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../fixtures",
);

function makeCtx(restParam: unknown): {
	ctx: AssetsHttpContext;
	getStatus: () => number;
	getBody: () => string | Buffer;
	getHeader: (name: string) => string | undefined;
} {
	let statusCode = 200;
	let body: string | Buffer = "";
	const headers = new Map<string, string>();
	const response: AssetsResponse = {
		status(code: number) {
			statusCode = code;
			return response;
		},
		header(name: string, value: string) {
			headers.set(name.toLowerCase(), value);
			return response;
		},
		send(out: string | Buffer) {
			body = out;
		},
	};
	return {
		ctx: {
			request: {
				param: (name: string) => (name === "*" ? restParam : undefined),
			},
			response,
		},
		getStatus: () => statusCode,
		getBody: () => body,
		getHeader: (name) => headers.get(name.toLowerCase()),
	};
}

describe("aurora > serveAssets", () => {
	it("serves a real file with the right content-type", async () => {
		const handler = serveAssets({ root: FIXTURES_ROOT });
		const { ctx, getStatus, getBody, getHeader } = makeCtx("pages/Hello.js");
		await handler(ctx);
		expect(getStatus()).toBe(200);
		expect(getHeader("content-type")).toMatch(/javascript/);
		expect(getHeader("cache-control")).toMatch(/max-age/);
		expect(String(getBody())).toContain("export default function Hello");
	});

	it("400s when the wildcard param is missing", async () => {
		const handler = serveAssets({ root: FIXTURES_ROOT });
		const { ctx, getStatus } = makeCtx(undefined);
		await handler(ctx);
		expect(getStatus()).toBe(400);
	});

	it("404s an asset that does not exist", async () => {
		const handler = serveAssets({ root: FIXTURES_ROOT });
		const { ctx, getStatus } = makeCtx("pages/Nope.js");
		await handler(ctx);
		expect(getStatus()).toBe(404);
	});

	it("403s on a path-traversal attempt", async () => {
		const handler = serveAssets({ root: FIXTURES_ROOT });
		const { ctx, getStatus } = makeCtx("../package.json");
		await handler(ctx);
		expect(getStatus()).toBe(403);
	});

	it("403s when a symlink under root resolves outside root", async () => {
		// Plant a symlink inside the assets fixture pointing at the
		// package's own package.json — a real-world equivalent of an
		// attacker / misconfiguration creating a symlink that escapes
		// the asset root. The lexical resolve+startsWith check passes
		// (the link itself is under root), but the realpath gate must
		// catch it.
		const { mkdtempSync, symlinkSync, rmSync, writeFileSync } = await import(
			"node:fs"
		);
		const { tmpdir } = await import("node:os");
		const tmpParent = mkdtempSync(`${tmpdir()}/aurora-symlink-`);
		try {
			const root = `${tmpParent}/root`;
			const outside = `${tmpParent}/outside-secret`;
			const { mkdirSync } = await import("node:fs");
			mkdirSync(root, { recursive: true });
			writeFileSync(outside, "SECRET=should-never-leak");
			symlinkSync(outside, `${root}/leak.json`);

			const handler = serveAssets({ root });
			const { ctx, getStatus, getBody } = makeCtx("leak.json");
			await handler(ctx);
			expect(getStatus()).toBe(403);
			expect(String(getBody() ?? "")).not.toContain("SECRET=");
		} finally {
			rmSync(tmpParent, { recursive: true, force: true });
		}
	});

	it("still serves files behind a symlinked ROOT (real-world current → release-X pattern)", async () => {
		// A symlinked root is legitimate: deploy systems often expose
		// `/var/www/current → /var/www/release-42`. The handler must
		// canonicalize the root once at construction and STILL serve
		// real files reached through that link.
		const { mkdtempSync, symlinkSync, rmSync, writeFileSync, mkdirSync } =
			await import("node:fs");
		const { tmpdir } = await import("node:os");
		const tmpParent = mkdtempSync(`${tmpdir()}/aurora-symlink-root-`);
		try {
			const realRoot = `${tmpParent}/release-42`;
			const symRoot = `${tmpParent}/current`;
			mkdirSync(realRoot, { recursive: true });
			writeFileSync(`${realRoot}/app.js`, "export default 1;");
			symlinkSync(realRoot, symRoot);

			const handler = serveAssets({ root: symRoot });
			// Tiny delay so the construction-time realpath promise resolves
			// before our request (handler kicks it off but doesn't await).
			await new Promise((r) => setTimeout(r, 10));
			const { ctx, getStatus, getBody } = makeCtx("app.js");
			await handler(ctx);
			expect(getStatus()).toBe(200);
			expect(String(getBody())).toContain("export default 1;");
		} finally {
			rmSync(tmpParent, { recursive: true, force: true });
		}
	});
});
