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
	type SharedProps,
	type SharedPropsResolver,
} from "./server/renderPage.js";
import {
	type AssetsHttpContext,
	packageAssetDir,
	serveAssets,
} from "./server/serveAssets.js";

export interface AuroraManagerConfig {
	pages: PagesConfig;
	/**
	 * Shared props injected into every `render()` call, matching Adonis/Inertia's
	 * request-level shared data model. Per-call `options.shared` is merged over it.
	 */
	shared?: SharedProps | SharedPropsResolver;
	/**
	 * Default root tag/class for rendered pages. Mirrors Inertia's root template
	 * customization while keeping controllers thin.
	 */
	root?: {
		tag?: string;
		class?: string;
	};
	/** Default asset/version marker serialized into the page payload. */
	assetsVersion?: string;
	/**
	 * Filesystem path to aurora's pre-built `dist/`. Defaults to the
	 * dist directory shipped with the installed `@c9up/aurora` package.
	 * Override only if you want to serve a custom build.
	 */
	auroraDistRoot?: string;
	/**
	 * Filesystem path to `@c9up/comet`'s `dist/`. Defaults to the dist of the
	 * installed (optional-peer) `@c9up/comet` — resolved automatically so the
	 * RPC client's `import '@c9up/comet'` works in the no-bundler browser with
	 * zero app wiring. Left unserved when comet isn't installed (no RPC).
	 */
	cometDistRoot?: string;
	/**
	 * URL prefix the asset routes mount under. The aurora runtime is served
	 * from `<assetsPrefix>/aurora/*` and the app's pages from
	 * `<assetsPrefix>/pages/*`, and the SSR importmap + page URLs derive from
	 * it. Default `/__assets` (the leading underscore namespaces framework
	 * assets away from app routes, Next.js `/_next` style). Set e.g. `/assets`
	 * for an underscore-free scheme. An explicit `pages.urlPrefix` still wins.
	 */
	assetsPrefix?: string;
	/**
	 * App-level importmap overrides, configured ONCE here (the AdonisJS model:
	 * config lives in `config/aurora.ts`, controllers stay thin and never hand-write
	 * importmaps). Merged over aurora's auto defaults (`@c9up/aurora`,
	 * `@c9up/aurora/rpc`, `@c9up/comet`) on every `render()`. Use to point a bare
	 * specifier at a curated browser entry, e.g.
	 * `{ '@c9up/aurora': '/__assets/pages/browser/aurora.js' }`. A per-call
	 * `render(..., { importmap })` still wins over this.
	 *
	 * (Importmaps are aurora's no-bundler particularity — AdonisJS bundles via Vite
	 * and has no importmap; we keep the config-driven shape to stay Adonis-idiomatic.)
	 */
	importmap?: Record<string, string>;
}

const DEFAULT_AURORA_DIST = resolvePath(
	dirname(fileURLToPath(import.meta.url)),
	"../dist",
);

/**
 * Resolve `@c9up/comet`'s dist dir, or `null` when it isn't installed. comet is
 * aurora's OPTIONAL peer (only present when the app uses RPC), so a missing one
 * is expected — aurora then simply doesn't serve it or add it to the importmap.
 */
function resolveCometDist(): string | null {
	try {
		return packageAssetDir("@c9up/comet");
	} catch {
		return null;
	}
}

/** Normalize an asset prefix: ensure a leading slash, drop trailing slashes. */
function normalizePrefix(prefix: string): string {
	const withLead = prefix.startsWith("/") ? prefix : `/${prefix}`;
	return withLead.replace(/\/+$/, "") || "/";
}

export class AuroraManager {
	readonly pages: Pages;
	readonly auroraDistRoot: string;
	/** Resolved asset prefix (default `/__assets`). */
	readonly assetsPrefix: string;
	/** Mount path for the aurora runtime — `<assetsPrefix>/aurora`. */
	readonly auroraAssetPath: string;
	/** Mount path for the app's pages — `<assetsPrefix>/pages`. */
	readonly pageAssetPath: string;
	/** Mount path for the RPC client's `@c9up/comet` runtime — `<assetsPrefix>/comet`. */
	readonly cometAssetPath: string;
	/** Resolved `@c9up/comet` dist dir, or `null` when comet isn't installed. */
	readonly cometDistRoot: string | null;
	/** App-level importmap overrides from `config/aurora.ts`, merged on render. */
	readonly importmap: Record<string, string>;
	/** App-level shared props from config/aurora.ts. */
	readonly shared?: SharedProps | SharedPropsResolver;
	/** App-level root element defaults from config/aurora.ts. */
	readonly root?: AuroraManagerConfig["root"];
	/** App-level asset/version marker. */
	readonly assetsVersion?: string;

	constructor(config: AuroraManagerConfig) {
		this.assetsPrefix = normalizePrefix(config.assetsPrefix ?? "/__assets");
		this.auroraAssetPath = `${this.assetsPrefix}/aurora`;
		this.pageAssetPath = `${this.assetsPrefix}/pages`;
		this.cometAssetPath = `${this.assetsPrefix}/comet`;
		this.cometDistRoot = config.cometDistRoot ?? resolveCometDist();
		this.importmap = config.importmap ?? {};
		this.shared = config.shared;
		this.root = config.root;
		this.assetsVersion = config.assetsVersion;
		// Pages serve their compiled JS from the same prefix unless the app
		// pins an explicit urlPrefix.
		this.pages = new Pages({
			...config.pages,
			urlPrefix: config.pages.urlPrefix ?? this.pageAssetPath,
		});
		this.auroraDistRoot = config.auroraDistRoot ?? DEFAULT_AURORA_DIST;
	}

	/**
	 * SSR + hydrate + ship the document. The importmap layers, last wins:
	 * aurora's auto defaults (`@c9up/aurora`, `@c9up/aurora/rpc`, `@c9up/comet`)
	 * < the config-level `importmap` (from `config/aurora.ts`) < a per-call
	 * `options.importmap`. So a thin controller calls `render(ctx, name, props)`
	 * with no importmap, and any curation lives once in config.
	 */
	render(
		ctx: RenderHttpContext,
		name: string,
		props: unknown,
		options?: RenderPageOptions,
	): Promise<void> {
		return renderPage(ctx, this.pages, name, props, {
			...options,
			rootTag: options?.rootTag ?? this.root?.tag,
			rootClass: options?.rootClass ?? this.root?.class,
			assetsVersion: options?.assetsVersion ?? this.assetsVersion,
			shared: mergeSharedResolvers(this.shared, options?.shared),
			importmap: {
				"@c9up/aurora": `${this.auroraAssetPath}/index.js`,
				// The browser-facing subpath (RPC client) needs an explicit entry —
				// importmaps don't read package `exports`, and an extensionless bare
				// specifier won't hit a trailing-slash prefix map. Served from the
				// same aurora dist; harmless when a page never imports it.
				"@c9up/aurora/rpc": `${this.auroraAssetPath}/rpc.js`,
				// Auto-map @c9up/comet when installed so the rpc client's bare
				// `import '@c9up/comet'` resolves in the no-bundler browser — no
				// app-side importmap wiring. Omitted when comet isn't present.
				...(this.cometDistRoot
					? { "@c9up/comet": `${this.cometAssetPath}/index.js` }
					: {}),
				// Config-level overrides (config/aurora.ts) — Adonis-style config-driven,
				// so controllers never hand-write an importmap. A per-call override wins.
				...this.importmap,
				...options?.importmap,
			},
		});
	}

	/**
	 * Handler for aurora's pre-built ESM runtime. Mount on
	 * `GET /__assets/aurora/*`.
	 */
	auroraAssetsHandler(): (ctx: AssetsHttpContext) => Promise<void> {
		return serveAssets({ root: this.auroraDistRoot });
	}

	/**
	 * Handler for the app's pages directory. Mount on
	 * `GET /__assets/pages/*`.
	 */
	pageAssetsHandler(): (ctx: AssetsHttpContext) => Promise<void> {
		return serveAssets({ root: this.pages.root });
	}

	/**
	 * Handler for `@c9up/comet`'s runtime (the RPC client). Mount on
	 * `GET <cometAssetPath>/*`. Returns `null` when comet isn't installed —
	 * the provider then skips the route (no RPC, nothing to serve).
	 */
	cometAssetsHandler(): ((ctx: AssetsHttpContext) => Promise<void>) | null {
		return this.cometDistRoot
			? serveAssets({ root: this.cometDistRoot })
			: null;
	}
}

function mergeSharedResolvers(
	base: AuroraManagerConfig["shared"],
	override: RenderPageOptions["shared"],
): RenderPageOptions["shared"] {
	if (!base) return override;
	if (!override) return base;
	return async (ctx) => ({
		...(await resolveShared(ctx, base)),
		...(await resolveShared(ctx, override)),
	});
}

async function resolveShared(
	ctx: RenderHttpContext,
	shared: SharedProps | SharedPropsResolver,
): Promise<SharedProps> {
	return typeof shared === "function" ? shared(ctx) : shared;
}
