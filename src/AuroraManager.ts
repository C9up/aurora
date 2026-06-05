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
}

const DEFAULT_AURORA_DIST = resolvePath(
	dirname(fileURLToPath(import.meta.url)),
	"../dist",
);

export class AuroraManager {
	readonly pages: Pages;
	readonly auroraDistRoot: string;

	constructor(config: AuroraManagerConfig) {
		this.pages = new Pages(config.pages);
		this.auroraDistRoot = config.auroraDistRoot ?? DEFAULT_AURORA_DIST;
	}

	/**
	 * SSR + hydrate + ship the document.
	 */
	render(
		ctx: RenderHttpContext,
		name: string,
		props: unknown,
		options?: RenderPageOptions,
	): Promise<void> {
		return renderPage(ctx, this.pages, name, props, options);
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
