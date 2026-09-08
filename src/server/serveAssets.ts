/**
 * `serveAssets` — generic static-file handler exposed by aurora so an
 * app can mount the runtime + the pages dist with a couple of routes:
 *
 *   router.get('/__assets/aurora/*', serveAssets({ root: auroraDistPath }))
 *   router.get('/__assets/pages/*',  serveAssets({ root: pagesPath }))
 *
 * The handler is framework-agnostic: it reads `ctx.request.param('*')`
 * and writes to `ctx.response`. Any context that satisfies
 * `AssetsHttpContext` (Ream, AdonisJS, anything duck-typed) works.
 */

import { createHash } from "node:crypto";
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

/**
 * Does `If-None-Match` cover this entity? (RFC 9110 §13.1.2)
 *
 * A strict `===` answered 200 for three shapes a real client sends: `*`, a
 * comma-separated list of tags, and the weak form `W/"…"` — so a browser
 * holding the exact bytes re-downloaded them anyway, which is most of what the
 * validator exists to prevent. Written here rather than imported because aurora
 * does not depend on ream; the same function lives in `ream/src/http/etag.ts`.
 */
function matchesIfNoneMatch(header: string | undefined, tag: string): boolean {
	if (header === undefined || header === "" || tag === "") return false;
	// `*` means "any current representation", so a stored copy always matches.
	if (header.trim() === "*") return true;
	const bare = (value: string): string =>
		value.startsWith("W/") ? value.slice(2) : value;
	const current = bare(tag);
	return header
		.split(",")
		.some((candidate) => bare(candidate.trim()) === current);
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
	/**
	 * Read a request header. OPTIONAL, so a host that only implements
	 * `param()` keeps working: without it there is no conditional request and
	 * every response is a full 200, which is what happened before.
	 */
	header?(name: string): string | undefined;
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
	 *
	 * Note that a TTL alone tells the browser not to ASK for 60 seconds. Pair
	 * it with `no-cache` while developing — the ETag below then makes the
	 * revalidation nearly free.
	 */
	cacheControl?: string;
}

export function serveAssets(
	options: ServeAssetsOptions,
): (ctx: AssetsHttpContext) => Promise<void> {
	// Normalize the root ONCE so the lexical containment gate below compares
	// like-for-like: a raw root with a trailing slash or a non-normalized
	// segment would never match the resolved request path → spurious 403s.
	const root = resolvePath(options.root);
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

		// A validator, so a cached copy can be CHECKED rather than only trusted
		// for a fixed time. Without one an edited module was served stale for
		// the whole TTL with no way for the browser to ask whether it changed —
		// in development that is a source file, and the answer is usually yes.
		//
		// Hashed from the bytes actually being sent rather than from mtime and
		// size: a checkout, a rebuild or a touched file all move the metadata
		// without changing the content, and each would needlessly re-download.
		const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
		const type =
			CONTENT_TYPES[extname(canonicalAbsolute)] ?? "application/octet-stream";
		ctx.response.header("content-type", type);
		ctx.response.header("cache-control", cacheControl);
		ctx.response.header("etag", etag);
		if (matchesIfNoneMatch(ctx.request.header?.("if-none-match"), etag)) {
			// 304 carries no body, and must not: the browser reuses the copy it
			// already has.
			ctx.response.status(304).send("");
			return;
		}
		ctx.response.send(body);
	};
}
