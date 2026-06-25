/**
 * AuroraProvider — registers the AuroraManager singleton and auto-mounts
 * the two asset routes the browser needs:
 *
 *   GET /_assets/aurora/*  → packages/@c9up/aurora/dist/*
 *   GET /_assets/pages/*   → resources/pages/*
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

import { isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { AuroraManager, type AuroraManagerConfig } from "./AuroraManager.js";
import { auroraRoute } from "./route.js";
import type {
	AssetsHttpContext,
	AssetsRequest,
	AssetsResponse,
} from "./server/serveAssets.js";
import { setAurora } from "./services/main.js";
import { renderToString } from "./ssr.js";

interface AuroraContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): T;
	has(token: unknown): boolean;
}
interface AuroraConfigStore {
	get<T = unknown>(key: string): T | undefined;
}
export interface AuroraAppContext {
	container: AuroraContainer;
	config: AuroraConfigStore;
}

interface ReamRouter {
	get(
		path: string,
		handler: (ctx: AssetsHttpContext) => Promise<void> | void,
	): unknown;
}

export default class AuroraProvider {
	constructor(protected app: AuroraAppContext) {}

	register(): void {
		this.app.container.singleton(AuroraManager, () => {
			const raw = this.app.config.get<AuroraManagerConfig>("aurora");
			const config = this.resolveConfig(raw);
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
		const manager = this.app.container.resolve<AuroraManager>(AuroraManager);
		setAurora(manager);
	}

	async start(): Promise<void> {
		// Asset routes are registered in `start()` — after preloads — so apps can
		// swap aurora's pages root in a preload if they wanted to.
		//
		// Resolve the host router from the container, where Ream registers it as
		// `'router'` (Ignitor). Reading it from the container — instead of
		// importing `@c9up/ream/services/router` — keeps aurora runtime-agnostic:
		// a non-Ream host simply never registers `'router'`, so aurora silently
		// skips its asset routes. The container yields the real Router instance
		// (registered before any provider's `start()`), so route-registration
		// failures (slug collision, AuroraManager crash) propagate with a stack
		// instead of being misread as "the asset routes just stopped mounting".
		if (!this.app.container.has("router")) return;
		const router = this.app.container.resolve<ReamRouter>("router");
		const manager = this.app.container.resolve<AuroraManager>(AuroraManager);
		// Mount paths derive from the configured `assetsPrefix` (default
		// `/_assets`) — set `config.aurora.assetsPrefix` to change the scheme.
		router.get(
			`${manager.auroraAssetPath}/*`,
			adaptHandler(manager.auroraAssetsHandler()),
		);
		router.get(
			`${manager.pageAssetPath}/*`,
			adaptHandler(manager.pageAssetsHandler()),
		);
	}

	async ready(): Promise<void> {}
	async shutdown(): Promise<void> {}

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
	private resolveConfig(
		raw: AuroraManagerConfig | undefined,
	): AuroraManagerConfig {
		const appRoot = this.readAppRoot();
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

	private readAppRoot(): string {
		try {
			const raw = this.app.container.resolve<unknown>("appRoot");
			if (raw instanceof URL) return fileURLToPath(raw);
			if (typeof raw === "string") return raw;
		} catch {
			// Host doesn't expose appRoot — fall through.
		}
		return process.cwd();
	}
}

/**
 * Adapter: serveAssets() returns a handler that takes our duck-typed
 * AssetsHttpContext. Ream's router passes its own HttpContext. The
 * two are structurally compatible (request.param + response.{status,
 * header, send}) but TypeScript needs the bridge made explicit.
 */
function adaptHandler(
	handler: (ctx: AssetsHttpContext) => Promise<void>,
): (ctx: {
	request: AssetsRequest;
	response: AssetsResponse;
}) => Promise<void> {
	return (ctx) => handler(ctx);
}
