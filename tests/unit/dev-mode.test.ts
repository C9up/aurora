/**
 * Dev behaviour — the per-render tree walk, the module resolve hook, page
 * assets served `no-cache`, the dev warnings — only when the environment
 * positively says development or test. An unset `NODE_ENV` (a bare
 * `node bin/server.js`, a container that never sets it) or a spelling such as
 * `prod` or `staging` is production.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ walk: 0, hooks: 0 }));

vi.mock("../../src/devPageReload.js", async (importOriginal) => {
	const actual: Record<string, unknown> = await importOriginal();
	return {
		...actual,
		newestMtime: () => {
			calls.walk++;
			return null;
		},
		registerDevPageHooks: async () => {
			calls.hooks++;
		},
	};
});

const { Pages } = await import("../../src/Pages.js");
const { AuroraManager } = await import("../../src/AuroraManager.js");
const { runsInDevelopment } = await import("../../src/devMode.js");

let root = "";

beforeEach(() => {
	calls.walk = 0;
	calls.hooks = 0;
	// Under the package tree: vitest's loader does not import from /tmp.
	root = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"fixtures",
		`_dev-mode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "Home.js"), "export default () => 'home';\n");
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** The Cache-Control the page assets handler answers `Home.js` with. */
async function pageAssetCacheControl(): Promise<string | undefined> {
	const manager = new AuroraManager({ pages: { root } });
	const headers = new Map<string, string>();
	const response = {
		status() {
			return response;
		},
		header(name: string, value: string) {
			headers.set(name.toLowerCase(), value);
			return response;
		},
		send() {},
	};
	await manager.pageAssetsHandler()({
		request: { param: () => "Home.js" },
		response,
	});
	return headers.get("cache-control");
}

describe("aurora > dev mode is opt-in", () => {
	for (const value of [undefined, "", "prod", "production", "staging"]) {
		it(`NODE_ENV=${String(value)} behaves as production`, async () => {
			vi.stubEnv("NODE_ENV", value);
			vi.stubEnv("REAM_DEV", undefined);
			expect(runsInDevelopment()).toBe(false);
			await new Pages({ root, extension: ".js" }).resolve("Home");
			expect(calls).toEqual({ walk: 0, hooks: 0 });
			expect(await pageAssetCacheControl()).not.toBe("no-cache");
		});
	}

	for (const value of [
		"dev",
		"develop",
		"development",
		"Development",
		"test",
		"testing",
	]) {
		it(`NODE_ENV=${value} is development`, async () => {
			vi.stubEnv("NODE_ENV", value);
			expect(runsInDevelopment()).toBe(true);
			await new Pages({ root, extension: ".js" }).resolve("Home");
			expect(calls).toEqual({ walk: 1, hooks: 1 });
			expect(await pageAssetCacheControl()).toBe("no-cache");
		});
	}

	it("`ream dev` (REAM_DEV=true) is development without NODE_ENV", () => {
		vi.stubEnv("NODE_ENV", undefined);
		vi.stubEnv("REAM_DEV", "true");
		expect(runsInDevelopment()).toBe(true);
	});
});
