import { normalizeNodeEnv } from "./vendor/nodeEnv.js";

/**
 * Whether aurora runs its development behaviour: the per-render walk of the
 * pages tree and the module resolve hook that reload edited pages, page assets
 * served `no-cache`, and the dev warnings.
 *
 * Only when the environment POSITIVELY says so — `ream dev` (`REAM_DEV=true`),
 * or a `NODE_ENV` that normalises to development or test. Anything else, unset
 * included, is production. Reading `NODE_ENV !== "production"` made a bare
 * `node bin/server.js` or `NODE_ENV=prod` walk and `stat` the whole pages tree
 * synchronously on every request, which an anonymous request flood multiplies.
 */
export function runsInDevelopment(): boolean {
	if (process.env.REAM_DEV === "true") return true;
	const env = normalizeNodeEnv(process.env.NODE_ENV);
	return env === "development" || env === "test";
}
