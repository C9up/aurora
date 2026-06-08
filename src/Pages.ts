/**
 * Page registry — resolves a page NAME (e.g. `"ProjectPage"`) to its
 * factory function, both server-side (dynamic import from disk) and
 * client-side (URL on the asset mount).
 *
 * Convention: pages live in a configurable root directory, one file
 * per page, default-exporting a function `(props) => TemplateResult`.
 *
 *   resources/pages/
 *     ProjectPage.js     → name `"ProjectPage"`
 *     dashboard/Home.js  → name `"dashboard/Home"`
 *
 * Sub-paths are allowed; the last `/`-separated segment is the file
 * stem (with or without the `.js` extension).
 */

import { resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { TemplateResult } from "./types.js";

/** A page module's default export. Receives props, returns a template. */
export type PageFactory<P = unknown> = (
	props: P,
) => TemplateResult | Promise<TemplateResult>;

export interface PagesConfig {
	/**
	 * Absolute filesystem path to the pages directory. The server
	 * imports `${root}/${name}.js` (or `${name}.ts` when transpiled at
	 * runtime by `@swc-node/register`).
	 */
	root: string;

	/**
	 * URL prefix the browser uses to fetch a page's compiled JS.
	 * Defaults to `/_assets/pages`. A name `"Foo"` maps to
	 * `${urlPrefix}/Foo.js`.
	 */
	urlPrefix?: string;

	/**
	 * File extension to append when neither the source nor the
	 * compiled module ships with one. Defaults to `.js` — Node ESM
	 * resolution requires the explicit extension, and `@swc-node`
	 * transparently handles `.ts` aliases that resolve back to `.js`.
	 */
	extension?: string;
}

/**
 * `Pages` is a tiny resolver — no caching, no glob, no magic. The
 * server imports the module dynamically on every render so editors +
 * `--watch` reloads pick up changes immediately. Apps that want a
 * pre-registered map (e.g. when pages are bundled into one entry) can
 * call `register()` to short-circuit the disk lookup.
 */
export class Pages {
	readonly root: string;
	readonly urlPrefix: string;
	readonly extension: string;

	private readonly registry = new Map<string, PageFactory>();

	constructor(config: PagesConfig) {
		this.root = config.root;
		this.urlPrefix = (config.urlPrefix ?? "/_assets/pages").replace(/\/$/, "");
		this.extension = config.extension ?? ".js";
	}

	/**
	 * Pre-register a page factory under `name`, bypassing the disk
	 * lookup. Useful for bundled apps and tests.
	 *
	 * Generic on the props shape so callers can pass a tightly-typed
	 * factory (e.g. `PageFactory<{ name: string }>`) without TS rejecting
	 * the call due to function-parameter contravariance. The factory is
	 * stored as `PageFactory<unknown>` because the registry hands props
	 * back as `unknown` — the renderer JSON.stringifies them either way.
	 */
	register<P>(name: string, factory: PageFactory<P>): void {
		this.registry.set(name, factory as PageFactory);
	}

	/**
	 * Resolve a page name to its factory function. Throws when the
	 * page is neither registered nor importable from disk.
	 *
	 * Path safety: `name` is rejected if it contains `..` segments or
	 * absolute-path markers. The joined path is also checked to live
	 * under `root` — defense in depth against URL-decoding tricks.
	 */
	async resolve(name: string): Promise<PageFactory> {
		const preset = this.registry.get(name);
		if (preset) return preset;

		assertSafeName(name);

		const absolute = resolvePath(this.root, `${name}${this.extension}`);
		if (!absolute.startsWith(this.root + sep) && absolute !== this.root) {
			throw new Error(
				`[aurora] page path "${name}" resolves outside the pages root`,
			);
		}

		// `pathToFileURL` so Windows + ESM stay happy. Node's ESM
		// loader caches modules by URL, so a stable URL would freeze
		// the first-imported version of the page for the whole process
		// lifetime — pages edited on disk would NOT be picked up even
		// when the app runs under a file watcher. In dev mode we bust
		// the URL with the file's mtime so a real change yields a new
		// cache key and triggers a re-import. In production we keep
		// the stable URL — page sources don't change post-deploy and
		// busting per-request would leak memory (each unique URL stays
		// resident in the ESM loader for the process lifetime).
		const isDev = process.env.NODE_ENV !== "production";
		let urlHref = pathToFileURL(absolute).href;
		if (isDev) {
			try {
				const { statSync } = await import("node:fs");
				urlHref = `${urlHref}?v=${statSync(absolute).mtimeMs}`;
			} catch {
				// stat failed → fall back to stable URL; the import below
				// will surface the underlying ENOENT.
			}
		}
		let mod: { default?: unknown };
		try {
			mod = (await import(urlHref)) as { default?: unknown };
		} catch (err) {
			throw new Error(
				`[aurora] page "${name}" not found at ${absolute} — ${
					(err as Error).message
				}`,
			);
		}
		if (typeof mod.default !== "function") {
			throw new Error(
				`[aurora] page "${name}" must default-export a factory function`,
			);
		}
		return mod.default as PageFactory;
	}

	/**
	 * Browser-side URL the importmap (or a `<script src="…">`) should
	 * point at to fetch the same page's compiled JS.
	 */
	urlFor(name: string): string {
		assertSafeName(name);
		return `${this.urlPrefix}/${name}${this.extension}`;
	}
}

function assertSafeName(name: string): void {
	if (
		name.length === 0 ||
		name.startsWith("/") ||
		name.startsWith("\\") ||
		name.includes("..") ||
		name.includes("\0")
	) {
		throw new Error(`[aurora] illegal page name: ${JSON.stringify(name)}`);
	}
}
