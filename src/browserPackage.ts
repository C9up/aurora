/**
 * Packages aurora serves to the no-bundler browser.
 *
 * This started as one special case (`@c9up/comet`, so the RPC client's bare
 * import resolved), became two (`@c9up/chronos`, which also needed its wasm),
 * and a third — `@c9up/atom` — would have copied the same fourteen lines a
 * third time. Per-package branches in the manager are not a mechanism; this is.
 *
 * What a package needs to be importable by bare specifier without a bundler:
 *
 * - its `dist/` on a URL, so the ESM actually downloads;
 * - its `wasm/` too WHEN it has one, because a wasm-backed package reaches out
 *   with `import("../wasm/…")` and the bindgen glue then fetches the binary
 *   beside itself — a sibling of the dist, not a child;
 * - an importmap entry pointing INTO `dist/`, so that `../wasm/…` lands on the
 *   sibling route instead of climbing out of the mount.
 *
 * What it must NOT get is the package root, which would answer both and also
 * publish `index.*.node` — server-only binaries, tens of megabytes of them.
 */

import { existsSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { packageAssetDir } from "./server/serveAssets.js";

/** A package resolved for browser delivery. */
export interface BrowserPackage {
	/** Bare specifier, as an app writes it: `@c9up/atom`. */
	readonly specifier: string;
	/** Last path segment, used for the mount: `atom`. */
	readonly slug: string;
	/** Mount path — `<assetsPrefix>/<slug>`. */
	readonly assetPath: string;
	/** Absolute `dist/` directory. */
	readonly distRoot: string;
	/** Absolute `wasm/` sibling, or `null` when the package has none. */
	readonly wasmRoot: string | null;
	/** Where the importmap should point: into `dist/`. */
	readonly entry: string;
}

/**
 * Resolve one specifier, or `null` when the package is not installed.
 *
 * Absence is the normal case, not a fault: these are optional peers, and an app
 * that never imports chronos should not be made to install it.
 */
export function resolveBrowserPackage(
	specifier: string,
	assetsPrefix: string,
	distRootOverride?: string,
): BrowserPackage | null {
	let distRoot: string;
	try {
		distRoot = distRootOverride ?? packageAssetDir(specifier);
	} catch {
		return null;
	}
	const slug = basename(specifier);
	const assetPath = `${assetsPrefix}/${slug}`;
	const wasmCandidate = resolvePath(distRoot, "..", "wasm");
	return {
		specifier,
		slug,
		assetPath,
		distRoot,
		// Probed rather than declared: a package gains or loses a wasm build
		// between releases, and a list here would be one more thing to keep in
		// step with packages aurora does not own.
		wasmRoot: existsSync(wasmCandidate) ? wasmCandidate : null,
		entry: `${assetPath}/dist/index.js`,
	};
}

/**
 * Resolve every specifier, dropping the ones that are not installed.
 *
 * A repeated slug is refused rather than silently served twice: two packages
 * mounted on one path means one of them is unreachable, and which one would
 * depend on registration order.
 */
export function resolveBrowserPackages(
	specifiers: readonly string[],
	assetsPrefix: string,
	overrides: Readonly<Record<string, string | undefined>> = {},
): BrowserPackage[] {
	const resolved: BrowserPackage[] = [];
	const seen = new Map<string, string>();
	for (const specifier of specifiers) {
		const pkg = resolveBrowserPackage(
			specifier,
			assetsPrefix,
			overrides[specifier],
		);
		if (!pkg) continue;
		const clash = seen.get(pkg.slug);
		if (clash !== undefined && clash !== specifier) {
			throw new Error(
				`[aurora] browser packages "${clash}" and "${specifier}" both mount on ` +
					`"${pkg.assetPath}" — one would be unreachable. Rename one, or serve it yourself.`,
			);
		}
		seen.set(pkg.slug, specifier);
		resolved.push(pkg);
	}
	return resolved;
}

/**
 * The packages aurora serves without being asked.
 *
 * Both are its own optional peers and both are imported by code aurora
 * generates or ships, so an app that installed them should not also have to
 * wire them. Anything else goes in `config.browserPackages`.
 */
export const DEFAULT_BROWSER_PACKAGES = ["@c9up/comet", "@c9up/chronos"];
