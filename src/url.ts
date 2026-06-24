/**
 * `urlFor` — isomorphic named-route URL builder (AdonisJS v7 parity), the client
 * half of Ream's `router.urlFor()`.
 *
 * Routes live server-side in Ream's router; this helper builds URLs from a
 * serialized `name → path-pattern` manifest so the SAME `urlFor(name, params)`
 * works in a page during SSR and after hydration in the browser — no more
 * hard-coded paths like `redirect('/login')` / `href: '/team'`.
 *
 *   urlFor('users.show', { id: 42 })        // → '/users/42'
 *   urlFor('auth.login')                    // → '/login'
 *   urlFor('search', {}, { q: 'ream', p: 2 })// → '/search?q=ream&p=2'
 *
 * The manifest is populated by {@link setRouteManifest}: `renderPage` calls it
 * server-side from `options.routes` (build it with `router.namedManifest()`), and
 * injects the same map into the page so the hydrate bootstrap re-sets it client
 * side. Node-free — part of aurora's client runtime.
 */

let manifest: Record<string, string> = {};

/**
 * Install the `name → path-pattern` map `urlFor` resolves against (e.g.
 * `{ 'users.show': '/users/:id' }`, from Ream's `router.namedManifest()`).
 * Replaces any previous manifest. Routes are static per app, so this is set once
 * per environment (server boot / page render, and the hydrate bootstrap).
 */
export function setRouteManifest(routes: Record<string, string>): void {
	manifest = { ...routes };
}

/** The currently-installed route manifest (mainly for tests/introspection). */
export function getRouteManifest(): Record<string, string> {
	return { ...manifest };
}

/**
 * Build a URL for a named route — fills `:param` placeholders, drops unprovided
 * optional (`:name?`) segments, appends `query` as a query string, and throws on
 * an unknown route or a missing required param. Mirrors Ream's `router.urlFor`.
 */
export function urlFor(
	name: string,
	params?: Record<string, string | number>,
	query?: Record<string, string | number>,
): string {
	const pattern = manifest[name];
	if (pattern === undefined) {
		const known = Object.keys(manifest);
		throw new Error(
			`[aurora] urlFor: unknown route '${name}'. ${
				known.length > 0
					? `Known: ${known.join(", ")}`
					: "No routes registered — was the manifest passed to render() / setRouteManifest() called?"
			}`,
		);
	}

	let url = pattern;
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			// Word-boundary substitution so `:id` doesn't corrupt `:idx`.
			const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			url = url.replace(
				new RegExp(`:${escaped}\\??(?![\\w])`, "g"),
				encodeURIComponent(String(value)),
			);
		}
	}

	// Strip remaining optional placeholders (`:name?` not provided).
	url = url.replace(/\/:[A-Za-z_][\w]*\?/g, "");

	const missing = url.match(/:[A-Za-z_][\w]*/g);
	if (missing && missing.length > 0) {
		throw new Error(
			`[aurora] urlFor: route '${name}' is missing params ${missing.join(", ")}`,
		);
	}

	if (query) {
		const qs = Object.entries(query)
			.map(
				([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
			)
			.join("&");
		if (qs) url += `${url.includes("?") ? "&" : "?"}${qs}`;
	}

	return url;
}
