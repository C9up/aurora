import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssetsHttpContext, AssetsResponse } from "../../src/server.js";
import { serveAssets } from "../../src/server.js";

/**
 * The pages mount serves the app's source directory, so a dotfile in it —
 * `.env`, `.git/config`, an editor's swap file — was one GET away. Like the
 * usual static servers' default, any path segment starting with `.` is a 404.
 */

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "aurora-dotfiles-"));
	writeFileSync(join(root, "Home.js"), "export default 1\n");
	writeFileSync(join(root, "a.b.js"), "export default 2\n");
	writeFileSync(join(root, ".env"), "DB_PASSWORD=hunter2\n");
	writeFileSync(join(root, ".Page.js.swp"), "swap\n");
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git", "config"), "[core]\n");
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "sub", ".hidden.js"), "hidden\n");
	// A normally named link to a dotfile inside the root.
	symlinkSync(join(root, ".env"), join(root, "config.js"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

async function get(
	rest: string,
	dotFiles?: "ignore" | "allow",
): Promise<{ status: number; body: string }> {
	let status = 200;
	let body = "";
	const response: AssetsResponse = {
		status(code) {
			status = code;
			return response;
		},
		header() {
			return response;
		},
		send(out) {
			body = String(out);
		},
	};
	const ctx: AssetsHttpContext = {
		request: { param: (name) => (name === "*" ? rest : undefined) },
		response,
	};
	await serveAssets({ root, dotFiles })(ctx);
	return { status, body };
}

describe("aurora > serveAssets > dotfiles", () => {
	it("answers 404 for a dotfile, a dot directory and a nested dotfile", async () => {
		for (const path of [
			".env",
			".git/config",
			"sub/.hidden.js",
			".Page.js.swp",
			"sub\\.hidden.js",
			"sub/../.env",
		]) {
			const reply = await get(path);
			expect(reply.status, path).toBe(404);
			expect(reply.body, path).not.toContain("hunter2");
		}
	});

	it("answers 404 for a normally named link to a dotfile", async () => {
		expect((await get("config.js")).status).toBe(404);
	});

	it("still serves ordinary files, dots inside a name included", async () => {
		expect(await get("Home.js")).toEqual({
			status: 200,
			body: "export default 1\n",
		});
		expect((await get("a.b.js")).status).toBe(200);
	});

	it("still answers 403 for a traversal", async () => {
		expect((await get("../../etc/passwd")).status).toBe(403);
	});

	it("serves dotfiles when told to", async () => {
		expect(await get(".env", "allow")).toEqual({
			status: 200,
			body: "DB_PASSWORD=hunter2\n",
		});
		expect((await get(".git/config", "allow")).status).toBe(200);
	});
});
