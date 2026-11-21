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
import {
	type BrowserPackage,
	DEFAULT_BROWSER_PACKAGES,
	resolveBrowserPackage,
	resolveBrowserPackages,
	subpathEntry,
} from "./browserPackage.js";
import { runsInDevelopment } from "./devMode.js";
import { AuroraError } from "./errors.js";
import { Pages, type PagesConfig } from "./Pages.js";
import {
	type ClientRoutesFilter,
	type RenderHttpContext,
	type RenderPageOptions,
	renderPage,
	type SharedProps,
	type SharedPropsResolver,
} from "./server/renderPage.js";
import { type AssetsHttpContext, serveAssets } from "./server/serveAssets.js";
import { loadVisitProtocol, type VisitProtocol } from "./server/visits.js";

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
	 * Which named routes every page carries to the browser — see
	 * `RenderPageOptions.clientRoutes`. A per-call `clientRoutes` wins.
	 */
	clientRoutes?: ClientRoutesFilter;
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
	 * Filesystem path to `@c9up/chronos`'s `dist/`. Defaults to the dist of the
	 * installed (optional-peer) chronos, so `import '@c9up/chronos'` resolves in
	 * the no-bundler browser with no app wiring. Left unserved when chronos
	 * isn't installed.
	 */
	chronosDistRoot?: string;
	/**
	 * Extra packages to serve to the browser, by bare specifier.
	 *
	 * `@c9up/comet` and `@c9up/chronos` are served already — aurora's own
	 * optional peers, imported by code it generates. Anything else an app wants
	 * importable without a bundler goes here:
	 *
	 *   browserPackages: ['@c9up/atom']
	 *
	 * Each resolved package gets `<assetsPrefix>/<name>/dist/*`, a `wasm/*`
	 * route when it has one, and an importmap entry. The entry is the file the
	 * package's `exports["."]` declares under `browser`, else under `import`,
	 * else `dist/index.js` — so a package with a separate browser build needs no
	 * hand-written `importmap`. A package that is not installed is skipped in
	 * silence, as the built-in two are.
	 */
	browserPackages?: string[];
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
	/**
	 * Page visits without a document reload, through photon's protocol: after
	 * the first load a link fetches the next page's object as JSON and the
	 * client renders it into the root. Needs `@c9up/photon`. Controllers do not
	 * change; set `assetsVersion` so a deploy reloads stale clients.
	 */
	visits?: boolean;
	/** Where @c9up/photon's built `dist/` is, when not where Node resolves it. */
	photonDistRoot?: string;
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

/**
 * Type a config where it is written — the `defineConfig` every ream module's
 * `config/<name>.ts` calls. A relative `pages.root` is resolved against the
 * application root by the provider.
 */
export function defineConfig(config: AuroraManagerConfig): AuroraManagerConfig {
	return config;
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
	/**
	 * Packages served to the browser, resolved and de-duplicated.
	 *
	 * Replaces what used to be a pair of fields per package. The third one that
	 * needed it would have copied the same fourteen lines again.
	 */
	readonly browserPackages: readonly BrowserPackage[];
	/** Mount path for `@c9up/comet`, or `null` when it isn't installed. */
	readonly cometAssetPath: string | null;
	/** Mount path for `@c9up/chronos`, or `null` when it isn't installed. */
	readonly chronosAssetPath: string | null;
	/** App-level importmap overrides from `config/aurora.ts`, merged on render. */
	readonly importmap: Record<string, string>;
	/** App-level shared props from config/aurora.ts. */
	readonly shared?: SharedProps | SharedPropsResolver;
	/** App-level root element defaults from config/aurora.ts. */
	readonly root?: AuroraManagerConfig["root"];
	/** App-level asset/version marker. */
	readonly assetsVersion?: string;
	readonly clientRoutes?: ClientRoutesFilter;
	/** With visits on: photon's client and aurora's boot in the importmap. */
	readonly visitImports: Readonly<Record<string, string>> | null;
	#visitProtocol: Promise<VisitProtocol> | null = null;

	constructor(config: AuroraManagerConfig) {
		this.assetsPrefix = normalizePrefix(config.assetsPrefix ?? "/__assets");
		this.auroraAssetPath = `${this.assetsPrefix}/aurora`;
		this.pageAssetPath = `${this.assetsPrefix}/pages`;
		this.browserPackages = resolveBrowserPackages(
			[...DEFAULT_BROWSER_PACKAGES, ...(config.browserPackages ?? [])],
			this.assetsPrefix,
			{
				"@c9up/comet": config.cometDistRoot,
				"@c9up/chronos": config.chronosDistRoot,
			},
		);
		this.visitImports = null;
		if (config.visits === true) {
			const photon = resolveBrowserPackage(
				"@c9up/photon",
				this.assetsPrefix,
				config.photonDistRoot,
			);
			const client = photon === null ? null : subpathEntry(photon, "./client");
			if (photon === null || client === null) {
				throw new AuroraError(
					"E_AURORA_VISITS_NEED_PHOTON",
					"[aurora] visits are on (config/aurora.ts) but @c9up/photon's built client is not installed: pnpm add @c9up/photon",
				);
			}
			// Served (its dist holds the client), but only its client entries are
			// mapped: photon's root entry is server code. `./client/core` is the
			// router without the bundled adapters — what a page shared with the
			// phone imports (a phone's bundler follows every import).
			const core = subpathEntry(photon, "./client/core");
			this.browserPackages = [...this.browserPackages, photon];
			this.visitImports = {
				"@c9up/photon/client": client,
				...(core === null ? {} : { "@c9up/photon/client/core": core }),
				"@c9up/aurora/visits": `${this.auroraAssetPath}/visits.js`,
			};
		}
		this.cometAssetPath =
			this.browserPackages.find((p) => p.specifier === "@c9up/comet")
				?.assetPath ?? null;
		this.chronosAssetPath =
			this.browserPackages.find((p) => p.specifier === "@c9up/chronos")
				?.assetPath ?? null;
		this.importmap = config.importmap ?? {};
		this.shared = config.shared;
		this.root = config.root;
		this.assetsVersion = config.assetsVersion;
		this.clientRoutes = config.clientRoutes;
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
	/** photon's protocol, loaded once, when visits are on. */
	visitProtocol(): Promise<VisitProtocol> | null {
		if (this.visitImports === null) return null;
		this.#visitProtocol ??= loadVisitProtocol();
		return this.#visitProtocol;
	}

	/**
	 * Around a request, with visits on: `Vary: X-Photon` before the handler,
	 * and after it the protocol's answers a visit gets instead of a page — 409
	 * on a stale asset version, 303 after a redirected PUT / PATCH / DELETE.
	 */
	async aroundVisit(
		ctx: RenderHttpContext,
		next: () => Promise<void>,
	): Promise<void> {
		const loading = this.visitProtocol();
		if (loading === null) return next();
		const protocol = await loading;
		const info = protocol.readRequestInfo(ctx);
		protocol.varyOnPhoton(ctx.response);
		await next();
		protocol.finishVisit(ctx, ctx.response, info, {
			url: protocol.readRequestUrl(ctx),
			version: this.assetsVersion ?? "",
		});
	}

	async render(
		ctx: RenderHttpContext,
		name: string,
		props: unknown,
		options?: RenderPageOptions,
	): Promise<void> {
		const visits = await this.visitProtocol();
		return renderPage(ctx, this.pages, name, props, {
			...(visits === null ? {} : { visits }),
			...options,
			rootTag: options?.rootTag ?? this.root?.tag,
			rootClass: options?.rootClass ?? this.root?.class,
			assetsVersion: options?.assetsVersion ?? this.assetsVersion,
			clientRoutes: options?.clientRoutes ?? this.clientRoutes,
			shared: mergeSharedResolvers(this.shared, options?.shared),
			importmap: {
				"@c9up/aurora": `${this.auroraAssetPath}/index.js`,
				// Every browser-facing subpath needs an explicit entry — importmaps
				// don't read package `exports`, and an extensionless bare specifier
				// won't hit a trailing-slash prefix map. Served from the same aurora
				// dist; harmless when a page never imports one.
				//
				// `relay` is the one that has to be here: unlike `hydrate` and
				// `ssr` it is NOT re-exported from the barrel, so a page that wants
				// the relay client has no other specifier to reach it by.
				//
				// The node-only subpaths (`provider`, `server`, `services/main`)
				// are deliberately absent: mapping them would hand the browser a
				// specifier that resolves to a module it cannot load.
				"@c9up/aurora/rpc": `${this.auroraAssetPath}/rpc.js`,
				"@c9up/aurora/relay": `${this.auroraAssetPath}/relay.js`,
				"@c9up/aurora/hydrate": `${this.auroraAssetPath}/hydrate.js`,
				"@c9up/aurora/ssr": `${this.auroraAssetPath}/ssr.js`,
				// Every served package, mapped INTO its dist so a relative
				// `../wasm/…` lands on the sibling route rather than climbing
				// out of the mount.
				...Object.fromEntries(
					this.browserPackages
						.filter((pkg) => pkg.specifier !== "@c9up/photon")
						.map((pkg) => [pkg.specifier, pkg.entry]),
				),
				...this.visitImports,
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
	 *
	 * `no-cache` while developing — which does NOT mean "do not cache", it
	 * means "always ask". These are source files: served with the default
	 * 60-second TTL and no validator, an edited page was handed back stale for
	 * a minute with no way for the browser even to enquire. The ETag makes the
	 * question cheap; production keeps the TTL.
	 */
	pageAssetsHandler(): (ctx: AssetsHttpContext) => Promise<void> {
		return serveAssets({
			root: this.pages.root,
			...(runsInDevelopment() ? { cacheControl: "no-cache" } : {}),
		});
	}

	/**
	 * Handler for `@c9up/comet`'s runtime (the RPC client). Mount on
	 * `GET <cometAssetPath>/*`. Returns `null` when comet isn't installed —
	 * the provider then skips the route (no RPC, nothing to serve).
	 */
	/**
	 * Handlers for one served package: its dist, and its wasm when it has one.
	 *
	 * Returned as a pair rather than mounted here so the provider stays the only
	 * thing that touches the router.
	 */
	browserPackageHandlers(pkg: BrowserPackage): {
		dist: (ctx: AssetsHttpContext) => Promise<void>;
		wasm: ((ctx: AssetsHttpContext) => Promise<void>) | null;
	} {
		return {
			dist: serveAssets({ root: pkg.distRoot }),
			wasm: pkg.wasmRoot ? serveAssets({ root: pkg.wasmRoot }) : null,
		};
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
