/**
 * AuroraProvider — registers the AuroraManager singleton and auto-mounts
 * the two asset routes the browser needs:
 *
 *   GET /__assets/aurora/*  → packages/@c9up/aurora/dist/*
 *   GET /__assets/pages/*   → resources/pages/*
 *
 * Config (in `config/aurora.ts`):
 *
 *   export default {
 *     pages: { root: new URL('../resources/pages', import.meta.url).pathname },
 *   }
 *
 * The duck-typed `AuroraAppContext` keeps this provider usable in any
 * framework with a container — non-Ream hosts get the singleton bindings
 * and skip the route auto-registration silently.
 */

import "./augmentations.js";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { AuroraManager, type AuroraManagerConfig } from "./AuroraManager.js";
import { auroraRoute } from "./route.js";
import {
	type AssetMount,
	type AssetsHost,
	assetsMiddleware,
} from "./server/assetsMiddleware.js";
import { clearAurora, getAurora, setAurora } from "./services/main.js";
import { renderToString } from "./ssr.js";

interface AuroraContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): Promise<T>;
	has(token: unknown): boolean;
}
interface AuroraConfigStore {
	get<T = unknown>(key: string): T | undefined;
}
export interface AuroraAppContext {
	container: AuroraContainer;
	config: AuroraConfigStore;
}

/**
 * The host's server, duck-typed.
 *
 * Only `use`, and only the plain-function form — aurora must not import its
 * host's HTTP types, and a lazy middleware class would mean resolving one
 * through a container aurora does not own.
 */
interface ReamServer {
	use(
		middleware: Array<
			(host: AssetsHost, next: () => Promise<void>) => Promise<void>
		>,
	): unknown;
}

export default class AuroraProvider {
	/** What this provider bound, so shutdown only clears its own. */
	#owned: AuroraManager | undefined;

	constructor(protected app: AuroraAppContext) {}

	register(): void {
		this.app.container.singleton(AuroraManager, async () => {
			const raw = this.app.config.get<AuroraManagerConfig>("aurora");
			const config = await this.#resolveConfig(raw);
			const manager = new AuroraManager(config);
			setAurora(manager);
			return manager;
		});
		this.app.container.singleton("aurora", () =>
			this.app.container.resolve<AuroraManager>(AuroraManager),
		);
		// Legacy stateless bindings — kept so existing apps that
		// `container.resolve('aurora.render')` still get a working
		// function. New code should use the singleton.
		this.app.container.singleton("aurora.renderToString", () => renderToString);
		this.app.container.singleton("aurora.route", () => auroraRoute);
	}

	async boot(): Promise<void> {
		// Force-resolve so `setAurora` runs even if the app never
		// touches the singleton from a preload.
		const manager =
			await this.app.container.resolve<AuroraManager>(AuroraManager);
		this.#owned = manager;
		setAurora(manager);
	}

	async start(): Promise<void> {
		// Registered in `start()`, which runs BEFORE the preloads — providers
		// start, then the `starting` hooks, then the preloads are imported. That
		// ordering is what puts this ahead of the application's own
		// `server.use([...])` in `start/kernel.ts`, which is the whole point:
		// an asset request must not reach the middleware that authenticates.
		//
		// SERVER middleware, not routes. Aurora ships its pages unbundled, so
		// one page load is dozens of `.js` requests — as routes they each ran
		// the application's whole stack, and anything resolving a user from a
		// session cookie paid a `SELECT` per file for bytes that are identical
		// for everybody. Upstream's `@adonisjs/static` registers itself the same
		// way, and never as a route.
		//
		// Resolved from the container rather than imported, so aurora stays
		// runtime-agnostic: a host that registers no `'server'` simply serves no
		// assets, exactly as it previously served none without a `'router'`.
		if (!this.app.container.has("server")) return;
		const server = await this.app.container.resolve<ReamServer>("server");
		const manager =
			await this.app.container.resolve<AuroraManager>(AuroraManager);

		// Mount paths derive from the configured `assetsPrefix` (default
		// `/__assets`) — set `config.aurora.assetsPrefix` to change the scheme.
		const mounts: AssetMount[] = [
			{
				prefix: manager.auroraAssetPath,
				handler: manager.auroraAssetsHandler(),
			},
			{ prefix: manager.pageAssetPath, handler: manager.pageAssetsHandler() },
		];
		// Every package aurora serves to the browser, in one loop. This used to
		// be a branch per package — comet, then chronos — and a third would
		// have been a third copy. `config.browserPackages` adds one in a line.
		for (const pkg of manager.browserPackages) {
			const { dist, wasm } = manager.browserPackageHandlers(pkg);
			mounts.push({ prefix: `${pkg.assetPath}/dist`, handler: dist });
			// The wasm sibling only when the package has one: a mount over a
			// directory that does not exist would answer 500, not 404.
			if (wasm) mounts.push({ prefix: `${pkg.assetPath}/wasm`, handler: wasm });
		}

		server.use([assetsMiddleware(mounts)]);
	}

	async ready(): Promise<void> {}
	async shutdown(): Promise<void> {
		// Release the module-level singleton, while it is still ours. A stopped
		// application left a dead Aurora manager reachable through `services/main`, and
		// with two applications in one process the survivor's binding must not
		// be the one cleared.
		if (this.#owned !== undefined && getAurora() === this.#owned) clearAurora();
		this.#owned = undefined;
	}

	/**
	 * Resolve the user-supplied config:
	 *   - relative `pages.root` (e.g. `./resources/pages`) is joined to
	 *     the project's `appRoot` URL — same convention `modules.path`
	 *     uses;
	 *   - absolute paths are passed through;
	 *   - missing config falls back to `<appRoot>/resources/pages`.
	 *
	 * `appRoot` is fetched from the container if the host registered
	 * one (Ream does, since v0.x — see Ignitor); other hosts get the
	 * `process.cwd()` fallback.
	 */
	async #resolveConfig(
		raw: AuroraManagerConfig | undefined,
	): Promise<AuroraManagerConfig> {
		const appRoot = await this.#readAppRoot();
		const userRoot = raw?.pages?.root;
		const root =
			typeof userRoot === "string" && userRoot.length > 0
				? isAbsolute(userRoot)
					? userRoot
					: resolvePath(appRoot, userRoot)
				: resolvePath(appRoot, "resources/pages");
		return {
			...(raw ?? {}),
			pages: { ...(raw?.pages ?? {}), root },
		};
	}

	async #readAppRoot(): Promise<string> {
		try {
			const raw = await this.app.container.resolve<unknown>("appRoot");
			if (raw instanceof URL) return fileURLToPath(raw);
			if (typeof raw === "string") return raw;
		} catch {
			// Host doesn't expose appRoot — fall through.
		}
		return process.cwd();
	}
}
