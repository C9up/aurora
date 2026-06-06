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
import { _setAurora } from "./services/main.js";
import { renderToString } from "./ssr.js";

interface AuroraContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): T;
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
			_setAurora(manager);
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
		// Force-resolve so `_setAurora` runs even if the app never
		// touches the singleton from a preload.
		const manager = this.app.container.resolve<AuroraManager>(AuroraManager);
		_setAurora(manager);
	}

	async start(): Promise<void> {
		// Asset routes are registered in `start()` — after preloads —
		// so apps can swap aurora's pages root in a preload if they
		// wanted to. Non-Ream hosts (no `@c9up/ream/services/router`)
		// AND pre-`_setRouter` boots (router proxy uninit) both
		// silent-return; ANY other error (slug collision, AuroraManager
		// crash, factory bug) propagates so real regressions surface
		// with a stack instead of "the asset routes just stopped
		// mounting".
		// Variable specifier so tsc does not statically resolve the optional
		// `@c9up/ream` peer at build time (keeps aurora agnostic /
		// standalone-buildable). Resolved to the host router only at runtime
		// when aurora actually runs inside Ream.
		const routerSpecifier = "@c9up/ream/services/router";
		let routerMod: { default: ReamRouter };
		try {
			routerMod = await import(routerSpecifier);
		} catch (err) {
			if (isModuleNotFound(err)) return;
			throw err;
		}
		const manager = this.app.container.resolve<AuroraManager>(AuroraManager);
		try {
			routerMod.default.get(
				"/_assets/aurora/*",
				adaptHandler(manager.auroraAssetsHandler()),
			);
			routerMod.default.get(
				"/_assets/pages/*",
				adaptHandler(manager.pageAssetsHandler()),
			);
		} catch (err) {
			if (isRouterProxyUninit(err)) return;
			throw err;
		}
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

/** Node's ERR_MODULE_NOT_FOUND surfaces on an Error subclass with `code`. */
function isModuleNotFound(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const { code } = err;
	return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/** Ream's router proxy throws this exact string before Ignitor wires it. */
function isRouterProxyUninit(err: unknown): boolean {
	return (
		err instanceof Error &&
		err.message.includes("Router accessed before initialization")
	);
}
