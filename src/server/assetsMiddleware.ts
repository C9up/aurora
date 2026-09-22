/**
 * Serving the client module graph AHEAD of the application.
 *
 * Aurora ships its pages unbundled, so one page load is dozens of `.js`
 * requests — ninety-six on a real application. Mounted as ROUTES they each ran
 * the whole middleware stack, and an application that resolves a user from a
 * session cookie therefore ran `SELECT * FROM users` ninety-six times for
 * bytes that are identical for everybody: the content of `Dashboard.js` does
 * not depend on who asked for it.
 *
 * Upstream reaches the same conclusion for the same reason — `@adonisjs/static`
 * registers itself with `codemods.registerMiddleware("server", …)` and never
 * as a route, so a static file short-circuits before routing.
 *
 * Every application otherwise had to write the exemption itself, in its own
 * kernel, for a cost the framework created. Most never would, and nothing
 * would tell them.
 *
 * Duck-typed throughout: aurora must not import its host's HTTP types.
 */

import type { AssetsHttpContext } from "./serveAssets.js";

/** One mounted tree: everything under `prefix` is served by `handler`. */
export interface AssetMount {
	/** No trailing slash — `/__assets/pages`. */
	prefix: string;
	handler: (ctx: AssetsHttpContext) => Promise<void>;
}

/** What the middleware needs from its host's context. */
export interface AssetsHost {
	request: {
		url(): string;
		method?(): string;
		header?(name: string): string | undefined;
	};
	response: AssetsHttpContext["response"];
}

/** Methods a file server answers. Anything else belongs to the application. */
const READ_METHODS = new Set(["GET", "HEAD"]);

export function assetsMiddleware(
	mounts: readonly AssetMount[],
): (host: AssetsHost, next: () => Promise<void>) => Promise<void> {
	// Longest prefix first: `/__assets/comet/dist` must win over a mount at
	// `/__assets/comet`, whatever order the manager listed them in.
	const ordered = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length);

	return async (host, next) => {
		const method = host.request.method?.() ?? "GET";
		if (!READ_METHODS.has(method.toUpperCase())) {
			await next();
			return;
		}

		// `url()` carries the query string; a cache-buster must not defeat the
		// prefix match or change which file is read.
		const path = host.request.url().split("?")[0] ?? "";

		for (const mount of ordered) {
			if (!path.startsWith(`${mount.prefix}/`)) continue;
			const rest = path.slice(mount.prefix.length + 1);
			// `serveAssets` reads the wildcard through `param('*')`, which is a
			// ROUTER concept. Synthesising it here keeps that handler exactly as
			// it is — framework-agnostic, and still usable as a plain route by a
			// host that prefers one.
			await mount.handler({
				request: {
					param: () => rest,
					header: (name: string) => host.request.header?.(name),
				},
				response: host.response,
			});
			// Deliberately no `next()`: the response is written, and the whole
			// point is that the application never sees the request.
			return;
		}

		await next();
	};
}
