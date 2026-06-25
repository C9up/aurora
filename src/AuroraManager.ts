/**
 * AuroraManager — the singleton behind `@c9up/aurora/services/main`.
 *
 *   import aurora from '@c9up/aurora/services/main'
 *
 *   async show(ctx) {
 *     await aurora.render(ctx, 'ProjectPage', { project, tasks })
 *   }
 *
 * The manager pairs a `Pages` registry with the SSR pipeline and the
 * dist-asset handler. The provider builds it from `config/aurora.ts`;
 * the app can also instantiate one manually for tests.
 */

import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { Pages, type PagesConfig } from "./Pages.js";
import {
	type RenderHttpContext,
	type RenderPageOptions,
	renderPage,
} from "./server/renderPage.js";
import { type AssetsHttpContext, serveAssets } from "./server/serveAssets.js";

export interface AuroraManagerConfig {
	pages: PagesConfig;
	/**
	 * Filesystem path to aurora's pre-built `dist/`. Defaults to the
	 * dist directory shipped with the installed `@c9up/aurora` package.
	 * Override only if you want to serve a custom build.
	 */
	auroraDistRoot?: string;
	/**
	 * URL prefix the asset routes mount under. The aurora runtime is served
	 * from `<assetsPrefix>/aurora/*` and the app's pages from
	 * `<assetsPrefix>/pages/*`, and the SSR importmap + page URLs derive from
	 * it. Default `/_assets` (the leading underscore namespaces framework
	 * assets away from app routes, Next.js `/_next` style). Set e.g. `/assets`
	 * for an underscore-free scheme. An explicit `pages.urlPrefix` still wins.
	 */
	assetsPrefix?: string;
}

const DEFAULT_AURORA_DIST = resolvePath(
	dirname(fileURLToPath(import.meta.url)),
	"../dist",
);

/** Normalize an asset prefix: ensure a leading slash, drop trailing slashes. */
function normalizePrefix(prefix: string): string {
	const withLead = prefix.startsWith("/") ? prefix : `/${prefix}`;
	return withLead.replace(/\/+$/, "") || "/";
}

export class AuroraManager {
	readonly pages: Pages;
	readonly auroraDistRoot: string;
	/** Resolved asset prefix (default `/_assets`). */
	readonly assetsPrefix: string;
	/** Mount path for the aurora runtime — `<assetsPrefix>/aurora`. */
	readonly auroraAssetPath: string;
	/** Mount path for the app's pages — `<assetsPrefix>/pages`. */
	readonly pageAssetPath: string;

	constructor(config: AuroraManagerConfig) {
		this.assetsPrefix = normalizePrefix(config.assetsPrefix ?? "/_assets");
		this.auroraAssetPath = `${this.assetsPrefix}/aurora`;
		this.pageAssetPath = `${this.assetsPrefix}/pages`;
		// Pages serve their compiled JS from the same prefix unless the app
		// pins an explicit urlPrefix.
		this.pages = new Pages({
			...config.pages,
			urlPrefix: config.pages.urlPrefix ?? this.pageAssetPath,
		});
		this.auroraDistRoot = config.auroraDistRoot ?? DEFAULT_AURORA_DIST;
	}

	/**
	 * SSR + hydrate + ship the document. The importmap default points
	 * `@c9up/aurora` at this manager's `assetsPrefix`; a caller's
	 * `options.importmap` still overrides (e.g. to remap to an app-curated
	 * browser entry).
	 */
	render(
		ctx: RenderHttpContext,
		name: string,
		props: unknown,
		options?: RenderPageOptions,
	): Promise<void> {
		return renderPage(ctx, this.pages, name, props, {
			...options,
			importmap: {
				"@c9up/aurora": `${this.auroraAssetPath}/index.js`,
				...options?.importmap,
			},
		});
	}

	/**
	 * Handler for aurora's pre-built ESM runtime. Mount on
	 * `GET /_assets/aurora/*`.
	 */
	auroraAssetsHandler(): (ctx: AssetsHttpContext) => Promise<void> {
		return serveAssets({ root: this.auroraDistRoot });
	}

	/**
	 * Handler for the app's pages directory. Mount on
	 * `GET /_assets/pages/*`.
	 */
	pageAssetsHandler(): (ctx: AssetsHttpContext) => Promise<void> {
		return serveAssets({ root: this.pages.root });
	}
}
