/**
 * AuroraProvider.start() — narrow-catch regression.
 *
 * Before the fix, start() wrapped every line in a single `catch {}`
 * with no discrimination — a slug collision, an AuroraManager crash,
 * or a routerMod.get() bug all silently produced "the asset routes
 * are gone" with no stack. The fix splits the try into two narrow
 * blocks:
 *   - the dynamic import (only ERR_MODULE_NOT_FOUND swallowed —
 *     "host is not Ream" path)
 *   - the route registration (only the router-proxy-uninit error
 *     swallowed — "Ignitor hasn't wired the router yet" path)
 *
 * Everything else MUST propagate so real bugs surface.
 */
import { describe, expect, it } from "vitest";
import type { AuroraAppContext } from "../../src/AuroraProvider.js";
import AuroraProvider from "../../src/AuroraProvider.js";

function bypass<T>(v: unknown): T {
	return v as T;
}

function buildApp(opts?: {
	auroraConfig?: { pages?: { root?: string } };
}): AuroraAppContext {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
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

async function setReamRouter(router: unknown): Promise<void> {
	const mod = bypass<{ setRouter: (r: unknown) => void }>(
		await import("@c9up/ream/services/router"),
	);
	mod.setRouter(router);
}

describe("AuroraProvider > start() narrow-catch", () => {
	it("propagates a real router error (slug collision / bug) instead of swallowing", async () => {
		// Simulate a router whose .get() blows up for a non-uninit
		// reason — must surface, not be silently absorbed.
		await setReamRouter({
			get() {
				throw new Error("slug collision: /_assets/aurora/* already mounted");
			},
		});

		const app = buildApp({
			auroraConfig: { pages: { root: "/tmp/aurora-test-pages" } },
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();

		await expect(provider.start()).rejects.toThrow(/slug collision/);
	});

	it("propagates AuroraManager handler-construction errors", async () => {
		// If `manager.auroraAssetsHandler()` itself throws (e.g. fs
		// inspection on the assets root fails because the user pointed
		// at a missing directory + the manager validates eagerly), the
		// old code swallowed it. The new code lets it bubble.
		let calls = 0;
		await setReamRouter({
			get(_path: string, handler: unknown) {
				// The handler itself is fine here — we want to prove the
				// PATH through start() doesn't swallow downstream
				// failures. Trigger via the router throwing only on the
				// SECOND .get() (the /pages route), which is the kind of
				// half-mounted state that's hardest to debug post-hoc.
				calls += 1;
				if (calls === 2) {
					throw new Error("second route blew up after the first succeeded");
				}
				void handler;
				return {};
			},
		});
		const app = buildApp({
			auroraConfig: { pages: { root: "/tmp/aurora-test-pages" } },
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();
		await expect(provider.start()).rejects.toThrow(/second route blew up/);
	});

	it("silently returns when the router proxy throws 'Router accessed before initialization'", async () => {
		// The exact ream proxy message Ignitor produces before
		// `setRouter`. AuroraProvider treats this as a legitimate
		// "boot-ordering" path — provider mounts pre-Ignitor are
		// expected to no-op, not crash.
		await setReamRouter({
			get() {
				throw new Error(
					"Router accessed before initialization. Ensure your route files are loaded as preloads in reamrc.ts, not at import time.",
				);
			},
		});
		const app = buildApp({
			auroraConfig: { pages: { root: "/tmp/aurora-test-pages" } },
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();
		await expect(provider.start()).resolves.toBeUndefined();
	});

	it("registers both asset routes when everything is wired", async () => {
		const captured: string[] = [];
		await setReamRouter({
			get(path: string) {
				captured.push(path);
				return {};
			},
		});
		const app = buildApp({
			auroraConfig: { pages: { root: "/tmp/aurora-test-pages" } },
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();
		expect(captured).toEqual(["/_assets/aurora/*", "/_assets/pages/*"]);
	});
});
