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

import { existsSync } from "node:fs";
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
	 * Defaults to `/__assets/pages`. A name `"Foo"` maps to
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

	readonly #registry = new Map<string, PageFactory>();

	constructor(config: PagesConfig) {
		// Normalize the root ONCE so the `startsWith(root + sep)` containment
		// check below compares like-for-like against the resolved page path.
		// A raw root with a trailing slash, a relative segment, or `..` would
		// otherwise never match the resolved absolute path → spurious 403s.
		this.root = resolvePath(config.root);
		this.urlPrefix = (config.urlPrefix ?? "/__assets/pages").replace(/\/$/, "");
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
		this.#registry.set(name, factory as PageFactory);
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
		const preset = this.#registry.get(name);
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
			throw pageImportError(name, absolute, err, isDev);
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

/**
 * Tell "this page does not exist" apart from "this page exists and its module
 * graph refused to load".
 *
 * `import()` fails for many reasons that say nothing about whether the page is
 * there: a syntax error anywhere in the graph, a throw at module top level, an
 * export missing from a transitively imported module. Reporting every one of
 * them as "not found", against the page's own path, sends the reader to the one
 * file that is certainly present, while the real cause arrives at the end of the
 * sentence naming a module the message never said was involved.
 *
 * The question is answered from the filesystem, not from the error text. Node
 * raises `ERR_MODULE_NOT_FOUND` for a missing specifier ANYWHERE in the graph
 * and names the page in both cases — as the missing module when it IS the page,
 * and as the IMPORTER when a transitive is missing:
 *
 *   Cannot find module '<missing>' imported from '<importer>'
 *
 * so a substring test mis-sorts the second. Parsing the message is worse than
 * fragile anyway: under a loader that is not plain Node (Vite's module runner,
 * say) the text is different entirely. Whether the page is on disk is the same
 * question under every loader.
 *
 * @internal exported for the tests that assert the classification
 */
export function pageImportError(
	name: string,
	absolute: string,
	cause: unknown,
	isDev: boolean,
): Error {
	const error = cause instanceof Error ? cause : new Error(String(cause));

	if (!existsSync(absolute)) {
		return new Error(`[aurora] page "${name}" not found at ${absolute}`, {
			cause: error,
		});
	}

	// A missing export is raised at link time as a SyntaxError, and it names the
	// specifier it could not satisfy. In dev that has a second cause worth
	// naming: the page URL is busted by mtime, its imports are not, so a module
	// edited on disk can stay frozen in the ESM cache for the life of the
	// process while the page around it is re-read on every request. The export
	// is then genuinely in the file and genuinely absent from the loaded module.
	const stale =
		isDev && error.message.includes("does not provide an export named")
			? "\n  That export may well be on disk. Only the page URL is cache-busted here," +
				"\n  so an edited module it imports can stay frozen in this process's ESM cache." +
				"\n  Restart the server, or run it under a loader hook that invalidates a page's" +
				"\n  dependents (hot-hook)."
			: "";

	return new Error(
		`[aurora] page "${name}" loaded from ${absolute} but its module graph failed: ${error.message}${stale}`,
		{ cause: error },
	);
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
