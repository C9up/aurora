// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configure } from "../../src/configure.js";
import { defineConfig } from "../../src/server.js";

/**
 * Read a stub the way `codemods.makeUsingStub` does.
 *
 * The real file, not a fixture: a test that stubbed this out would pass with a
 * stub that does not exist.
 */
function renderStub(
	stubsRoot: string,
	stubPath: string,
): { to: string; body: string } {
	const raw = readFileSync(resolve(stubsRoot, stubPath), "utf8");
	const [, front = "", body = ""] = raw.split(/^---\r?\n/m, 3);
	const to = /^to:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
	return { to, body };
}

function codemods() {
	const written = new Map<string, string>();
	return {
		addProvider: vi.fn().mockResolvedValue(undefined),
		makeUsingStub: vi.fn(async (stubsRoot: string, stubPath: string) => {
			const { to, body } = renderStub(stubsRoot, stubPath);
			written.set(to, body);
			return { path: to, contents: body };
		}),
		written,
	};
}

describe("aurora > configure", () => {
	it("registers the provider and writes config/aurora.ts", async () => {
		const c = codemods();
		await configure(c);
		expect(c.addProvider).toHaveBeenCalledWith("@c9up/aurora/provider");
		expect([...c.written.keys()]).toEqual(["config/aurora.ts"]);
	});

	it("writes a config the provider reads: defineConfig from the server entry, a pages root", async () => {
		const c = codemods();
		await configure(c);
		const config = c.written.get("config/aurora.ts") ?? "";
		expect(config).toContain(
			"import { defineConfig } from '@c9up/aurora/server'",
		);
		expect(config).toMatch(/pages:\s*\{\s*root: 'resources\/pages',/);
		// Not from the browser entry, which must stay free of server code.
		expect(config).not.toContain("from '@c9up/aurora'");
	});

	it("exposes defineConfig as a typed identity", () => {
		const config = { pages: { root: "resources/pages" } };
		expect(defineConfig(config)).toBe(config);
	});
});
