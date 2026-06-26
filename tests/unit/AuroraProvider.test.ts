/**
 * AuroraProvider.start() — router resolution + error propagation.
 *
 * start() resolves the host router from the container (Ream registers it as
 * `'router'`), NOT by importing `@c9up/ream/services/router` — that keeps
 * aurora runtime-agnostic. The behaviour this locks:
 *   - no `'router'` registered (non-Ream host / router not wired) → silent
 *     no-op (asset routes simply aren't mounted);
 *   - a real route-registration error (slug collision, AuroraManager crash,
 *     router.get() bug) propagates with a stack instead of silently producing
 *     "the asset routes are gone".
 */
import { describe, expect, it } from "vitest";
import { AuroraManager } from "../../src/AuroraManager.js";
import type { AuroraAppContext } from "../../src/AuroraProvider.js";
import AuroraProvider from "../../src/AuroraProvider.js";

function bypass<T>(v: unknown): T {
	return v as T;
}

function buildApp(opts?: {
	auroraConfig?: { pages?: { root?: string }; assetsPrefix?: string };
	/** When set, registered under the `'router'` token (mirrors Ignitor). */
	router?: unknown;
}): AuroraAppContext {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	if (opts?.router !== undefined) cache.set("router", opts.router);
	return {
		container: {
			singleton(token, factory) {
				bindings.set(token, bypass<() => unknown>(factory));
			},
			resolve<T>(token: unknown): T {
				if (cache.has(token)) return bypass<T>(cache.get(token));
				const factory = bindings.get(token);
				if (!factory) throw new Error(`not registered: ${String(token)}`);
				const value = factory();
				cache.set(token, value);
				return bypass<T>(value);
			},
			has(token: unknown): boolean {
				return cache.has(token) || bindings.has(token);
			},
		},
		config: {
			get<T>(key: string): T | undefined {
				if (key === "aurora" && opts?.auroraConfig !== undefined) {
					return bypass<T>(opts.auroraConfig);
				}
				return undefined;
			},
		},
	};
}

describe("AuroraProvider > start() router resolution", () => {
	it("propagates a real router error (slug collision / bug) instead of swallowing", async () => {
		// A router whose .get() blows up for a non-degradation reason — must
		// surface, not be silently absorbed.
		const app = buildApp({
			auroraConfig: { pages: { root: "/tmp/aurora-test-pages" } },
			router: {
				get() {
					throw new Error("slug collision: /_assets/aurora/* already mounted");
				},
			},
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();

		await expect(provider.start()).rejects.toThrow(/slug collision/);
	});

	it("propagates AuroraManager handler-construction errors", async () => {
		// Prove the PATH through start() doesn't swallow downstream failures:
		// the router throws on the SECOND .get() (the /pages route) — the kind of
		// half-mounted state that's hardest to debug post-hoc.
		let calls = 0;
		const app = buildApp({
			auroraConfig: { pages: { root: "/tmp/aurora-test-pages" } },
			router: {
				get(_path: string, handler: unknown) {
					calls += 1;
					if (calls === 2) {
						throw new Error("second route blew up after the first succeeded");
					}
					void handler;
					return {};
				},
			},
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();
		await expect(provider.start()).rejects.toThrow(/second route blew up/);
	});

	it("silently returns when no 'router' is registered (non-Ream host)", async () => {
		// A host that never registered `'router'` (not Ream, or the router isn't
		// wired): aurora skips its asset routes rather than crashing.
		const app = buildApp({
			auroraConfig: { pages: { root: "/tmp/aurora-test-pages" } },
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();
		await expect(provider.start()).resolves.toBeUndefined();
	});

	it("registers the asset routes (aurora + pages + comet) when everything is wired", async () => {
		const captured: string[] = [];
		const app = buildApp({
			auroraConfig: { pages: { root: "/tmp/aurora-test-pages" } },
			router: {
				get(path: string) {
					captured.push(path);
					return {};
				},
			},
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();
		expect(captured).toEqual([
			"/_assets/aurora/*",
			"/_assets/pages/*",
			"/_assets/comet/*",
		]);
	});

	it("derives both asset mounts from a custom assetsPrefix (no underscore)", async () => {
		const captured: string[] = [];
		const app = buildApp({
			auroraConfig: {
				pages: { root: "/tmp/aurora-test-pages" },
				assetsPrefix: "/assets",
			},
			router: {
				get(path: string) {
					captured.push(path);
					return {};
				},
			},
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();
		expect(captured).toEqual([
			"/assets/aurora/*",
			"/assets/pages/*",
			"/assets/comet/*",
		]);
	});
});

describe("AuroraManager — asset prefix derivation", () => {
	it("defaults to /_assets and derives the aurora/pages paths", () => {
		const m = new AuroraManager({ pages: { root: "/tmp/x" } });
		expect(m.auroraAssetPath).toBe("/_assets/aurora");
		expect(m.pageAssetPath).toBe("/_assets/pages");
		expect(m.pages.urlFor("Hello")).toBe("/_assets/pages/Hello.js");
	});

	it("derives everything from a custom assetsPrefix (trailing slash trimmed)", () => {
		const m = new AuroraManager({
			pages: { root: "/tmp/x" },
			assetsPrefix: "/assets/",
		});
		expect(m.auroraAssetPath).toBe("/assets/aurora");
		expect(m.pageAssetPath).toBe("/assets/pages");
		expect(m.pages.urlFor("Hello")).toBe("/assets/pages/Hello.js");
	});

	it("an explicit pages.urlPrefix still wins over assetsPrefix", () => {
		const m = new AuroraManager({
			pages: { root: "/tmp/x", urlPrefix: "/custom/pages" },
			assetsPrefix: "/assets",
		});
		expect(m.pages.urlFor("Hello")).toBe("/custom/pages/Hello.js");
		expect(m.auroraAssetPath).toBe("/assets/aurora");
	});
});
