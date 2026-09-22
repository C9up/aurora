/**
 * AuroraProvider.start() — server resolution + error propagation.
 *
 * start() resolves the host SERVER from the container (Ream registers it as
 * `'server'`), NOT by importing `@c9up/ream/services/server` — that keeps
 * aurora runtime-agnostic. Server middleware and not routes, because an asset
 * must not traverse the application's stack: see `server/assetsMiddleware.ts`.
 * The behaviour this locks:
 *   - no `'server'` registered (non-Ream host / server not wired) → silent
 *     no-op (the asset mounts simply aren't installed);
 *   - a real registration error (a broken `'server'` binding, a `use()` that
 *     throws) propagates with a stack instead of silently producing "the
 *     assets are gone".
 */
import { describe, expect, it } from "vitest";
import { AuroraManager } from "../../src/AuroraManager.js";
import type { AuroraAppContext } from "../../src/AuroraProvider.js";
import AuroraProvider from "../../src/AuroraProvider.js";
import type { AssetsHost } from "../../src/server/assetsMiddleware.js";
import type { AssetsResponse } from "../../src/server/serveAssets.js";

type AssetsMiddleware = (
	host: AssetsHost,
	next: () => Promise<void>,
) => Promise<void>;

function bypass<T>(v: unknown): T {
	return v as T;
}

function buildApp(opts?: {
	auroraConfig?: { pages?: { root?: string }; assetsPrefix?: string };
	/** When set, registered under the `'server'` token (mirrors Ignitor). */
	server?: unknown;
	/** A `'server'` binding that blows up when resolved. */
	serverFactory?: () => unknown;
}): AuroraAppContext {
	const bindings = new Map<unknown, () => unknown>();
	const cache = new Map<unknown, unknown>();
	if (opts?.server !== undefined) cache.set("server", opts.server);
	if (opts?.serverFactory !== undefined)
		bindings.set("server", opts.serverFactory);
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

/** A host server that records what aurora installed on it. */
function recordingServer(): {
	installed: AssetsMiddleware[];
	server: { use(middleware: AssetsMiddleware[]): void };
} {
	const installed: AssetsMiddleware[] = [];
	return {
		installed,
		server: {
			use(middleware) {
				installed.push(...middleware);
			},
		},
	};
}

/**
 * Send one request through the installed middleware.
 *
 * The mounts are only observable through what they answer — which is the
 * property that matters anyway: a URL either never reaches the application, or
 * it does.
 */
async function probe(
	middleware: AssetsMiddleware,
	url: string,
	method = "GET",
): Promise<{ reachedApp: boolean; answered: boolean }> {
	let reachedApp = false;
	let answered = false;
	const response: AssetsResponse = {
		status() {
			return response;
		},
		header() {
			return response;
		},
		send() {
			answered = true;
		},
	};
	await middleware(
		{
			request: {
				url: () => url,
				method: () => method,
				header: () => undefined,
			},
			response,
		},
		async () => {
			reachedApp = true;
		},
	);
	return { reachedApp, answered };
}

describe("AuroraProvider > start() server resolution", () => {
	it("propagates a real registration error instead of swallowing", async () => {
		// A server whose .use() blows up for a non-degradation reason — must
		// surface, not be silently absorbed into "the assets are gone".
		const app = buildApp({
			auroraConfig: { pages: { root: "/tmp/aurora-test-pages" } },
			server: {
				use() {
					throw new Error("middleware stack already sealed");
				},
			},
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();

		await expect(provider.start()).rejects.toThrow(/already sealed/);
	});

	it("propagates a broken 'server' binding rather than serving nothing", async () => {
		// `has('server')` is true and resolving it fails: the host meant to wire a
		// server and could not. Silently skipping here is the half-mounted state
		// that is hardest to debug post-hoc.
		const app = buildApp({
			auroraConfig: { pages: { root: "/tmp/aurora-test-pages" } },
			serverFactory() {
				throw new Error("http server failed to construct");
			},
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();

		await expect(provider.start()).rejects.toThrow(/failed to construct/);
	});

	it("silently returns when no 'server' is registered (non-Ream host)", async () => {
		// A host that never registered `'server'` (not Ream, or the server isn't
		// wired): aurora skips its asset mounts rather than crashing.
		const app = buildApp({
			auroraConfig: { pages: { root: "/tmp/aurora-test-pages" } },
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();
		await expect(provider.start()).resolves.toBeUndefined();
	});

	it("installs ONE server middleware that answers aurora + pages + comet", async () => {
		const { installed, server } = recordingServer();
		const app = buildApp({
			auroraConfig: { pages: { root: "/tmp/aurora-test-pages" } },
			server,
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();

		// One, not one per mount: the whole tree is decided before routing.
		expect(installed).toHaveLength(1);
		const middleware = installed[0];
		if (!middleware) throw new Error("expected a middleware to be installed");

		for (const url of [
			"/__assets/aurora/index.js",
			"/__assets/pages/Hello.js",
			"/__assets/comet/dist/index.js",
		]) {
			expect(await probe(middleware, url)).toEqual({
				reachedApp: false,
				answered: true,
			});
		}

		// And an application URL is untouched — that is the other half of the
		// contract: aurora must not shadow routes it does not own.
		expect((await probe(middleware, "/dashboard")).reachedApp).toBe(true);
	});

	it("derives the mounts from a custom assetsPrefix (no underscore)", async () => {
		const { installed, server } = recordingServer();
		const app = buildApp({
			auroraConfig: {
				pages: { root: "/tmp/aurora-test-pages" },
				assetsPrefix: "/assets",
			},
			server,
		});
		const provider = new AuroraProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();

		const middleware = installed[0];
		if (!middleware) throw new Error("expected a middleware to be installed");

		expect((await probe(middleware, "/assets/aurora/index.js")).answered).toBe(
			true,
		);
		expect((await probe(middleware, "/assets/pages/Hello.js")).answered).toBe(
			true,
		);
		// The default prefix is no longer served — the prefix is a config, not a
		// second mount.
		expect(
			(await probe(middleware, "/__assets/aurora/index.js")).reachedApp,
		).toBe(true);
	});
});

describe("AuroraManager — asset prefix derivation", () => {
	it("defaults to /__assets and derives the aurora/pages paths", () => {
		const m = new AuroraManager({ pages: { root: "/tmp/x" } });
		expect(m.auroraAssetPath).toBe("/__assets/aurora");
		expect(m.pageAssetPath).toBe("/__assets/pages");
		expect(m.pages.urlFor("Hello")).toBe("/__assets/pages/Hello.js");
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

describe("AuroraProvider > shutdown", () => {
	it("releases the services/main singleton it bound", async () => {
		const { getAurora } = await import("../../src/services/main.js");
		const provider = new AuroraProvider(buildApp());
		provider.register();
		await provider.boot();
		expect(getAurora()).toBeDefined();

		await provider.shutdown();

		// A stopped application left a dead Aurora manager reachable through
		// `import aurora from '@c9up/aurora/services/main'`.
		expect(getAurora()).toBeUndefined();
	});

	it("leaves what another application has since bound alone", async () => {
		const { getAurora } = await import("../../src/services/main.js");
		const provider = new AuroraProvider(buildApp());
		provider.register();
		await provider.boot();

		// A second application boots in the same process and takes the singleton
		// over; the first one then shuts down.
		const other = new AuroraProvider(buildApp());
		other.register();
		await other.boot();
		const replacement = getAurora();
		if (!replacement) throw new Error("expected the second boot to bind one");

		await provider.shutdown();

		expect(getAurora()).toBe(replacement);
	});
});
