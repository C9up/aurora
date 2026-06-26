/**
 * `serveAssets` — generic static-file handler exposed by aurora so an
 * app can mount the runtime + the pages dist with a couple of routes:
 *
 *   router.get('/_assets/aurora/*', serveAssets({ root: auroraDistPath }))
 *   router.get('/_assets/pages/*',  serveAssets({ root: pagesPath }))
 *
 * The handler is framework-agnostic: it reads `ctx.request.param('*')`
 * and writes to `ctx.response`. Any context that satisfies
 * `AssetsHttpContext` (Ream, AdonisJS, anything duck-typed) works.
 */

import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute dist directory of an installed package — for mounting its pre-built
 * ESM as browser assets (`serveAssets({ root: packageAssetDir('@c9up/x') })`).
 *
 * Uses `import.meta.resolve`, which honours the package's `exports` `import`
 * condition — so it works for `@c9up/*` import-only packages where
 * `createRequire().resolve()` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` (their
 * `exports` carry no `require` condition, and `main` is ignored once `exports`
 * exists). Throws if the package isn't installed/resolvable.
 */
export function packageAssetDir(specifier: string): string {
	return dirname(fileURLToPath(import.meta.resolve(specifier)));
}

const CONTENT_TYPES: Record<string, string> = {
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
};

export interface AssetsRequest {
	/**
	 * Read the wildcard `*` segment of the matched route. Most routers
	 * (Ream, AdonisJS, fastify with params) expose this as
	 * `params['*']` — the duck-typed helper below accepts either
	 * convention.
	 */
	param(name: string): unknown;
}
export interface AssetsResponse {
	status(code: number): AssetsResponse;
	header(name: string, value: string): AssetsResponse;
	send(body: string | Buffer): void;
}
export interface AssetsHttpContext {
	request: AssetsRequest;
	response: AssetsResponse;
}

export interface ServeAssetsOptions {
	/**
	 * Absolute filesystem root the handler is allowed to serve from.
	 * Requests resolving outside this root return 403.
	 */
	root: string;
	/**
	 * `Cache-Control` value to emit. Defaults to a dev-friendly
	 * 60-second TTL. Production deployments should hash the asset
	 * name and switch to `public, max-age=31536000, immutable`.
	 */
	cacheControl?: string;
}

export function serveAssets(
	options: ServeAssetsOptions,
): (ctx: AssetsHttpContext) => Promise<void> {
	const root = options.root;
	const cacheControl = options.cacheControl ?? "public, max-age=60";
	// Canonicalize the root ONCE at handler creation. The realpath check
	// below compares against this canonical form so a symlinked root
	// (e.g. `/var/www/current → /var/www/release-42`) still resolves
	// requests correctly. `realpath` failure at construction means the
	// configured root doesn't exist yet — we fall back to the lexical
	// resolve so the first request emits a clean 404 instead of a boot
	// crash. The realpath re-check at request time handles that case.
	let canonicalRoot: string | undefined;
	realpath(root).then(
		(p) => {
			canonicalRoot = p;
		},
		() => {
			/* root not yet on disk — request-time realpath will surface it */
		},
	);

	return async (ctx) => {
		const rest = ctx.request.param("*");
		if (typeof rest !== "string" || rest.length === 0) {
			ctx.response.status(400).send("missing asset path");
			return;
		}
		// First gate: lexical containment check. `resolve()` collapses
		// `../` segments; we assert the resolved path still starts with
		// `root + sep`. This blocks the "../../../etc/passwd" class of
		// requests before we ever touch the filesystem.
		const absolute = resolvePath(join(root, rest));
		if (!absolute.startsWith(root + sep) && absolute !== root) {
			ctx.response.status(403).send("forbidden");
			return;
		}

		// Second gate: dereference any symlinks under the root and
		// re-check containment against the canonical root. Without this
		// step a symlink planted at `<root>/legit → /etc/secrets` would
		// pass the lexical check above and be served. We re-canonicalize
		// the root each request when the constructor-time realpath
		// hadn't resolved yet (root mounted after boot).
		let canonicalAbsolute: string;
		let canonicalRootNow: string;
		try {
			canonicalRootNow = canonicalRoot ?? (await realpath(root));
			canonicalAbsolute = await realpath(absolute);
		} catch {
			// realpath fails if the target doesn't exist — emit a normal
			// 404 here so symlink-escape probes can't be distinguished
			// from genuine misses via response timing or status.
			ctx.response.status(404).send("asset not found");
			return;
		}
		if (
			!canonicalAbsolute.startsWith(canonicalRootNow + sep) &&
			canonicalAbsolute !== canonicalRootNow
		) {
			ctx.response.status(403).send("forbidden");
			return;
		}

		let body: Buffer;
		try {
			body = await readFile(canonicalAbsolute);
		} catch {
			ctx.response.status(404).send("asset not found");
			return;
		}

		const type =
			CONTENT_TYPES[extname(canonicalAbsolute)] ?? "application/octet-stream";
		ctx.response.header("content-type", type);
		ctx.response.header("cache-control", cacheControl);
		ctx.response.send(body);
	};
}
