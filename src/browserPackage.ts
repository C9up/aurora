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

import { existsSync, readFileSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve as resolvePath,
	sep,
} from "node:path";
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
	/**
	 * Where the importmap should point: into `dist/`, at the file the package
	 * declares for the browser (see {@link browserEntryFile}).
	 */
	readonly entry: string;
}

/**
 * The conditions an importmap entry is resolved with, MOST preferred first.
 *
 * Preference, not the order of the package's keys. Node's algorithm takes the
 * first key of `exports` that is in the active set, so `{ import, browser }`
 * hands a bundler the `import` file. An importmap is read by a browser and
 * nothing else, so a `browser` file the package ships wins wherever it is
 * listed: the `import` entry of a package that has a separate browser build is
 * the one that reaches for `node:fs`.
 */
const ENTRY_CONDITIONS = ["browser", "import", "default"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A browser runs JavaScript. A package linked from a workspace exports its
 * TypeScript source (`./src/index.ts`), which is no entry for an importmap, so
 * such a target is passed over rather than mapped.
 */
const JAVASCRIPT = /\.m?js$/;

/** One `exports` target, narrowed by {@link ENTRY_CONDITIONS}. */
function resolveTarget(target: unknown): string | null {
	if (typeof target === "string")
		return JAVASCRIPT.test(target) ? target : null;
	if (Array.isArray(target)) {
		for (const candidate of target) {
			const resolved = resolveTarget(candidate);
			if (resolved !== null) return resolved;
		}
		return null;
	}
	if (!isRecord(target)) return null;
	for (const condition of ENTRY_CONDITIONS) {
		if (condition in target) {
			const resolved = resolveTarget(target[condition]);
			if (resolved !== null) return resolved;
		}
	}
	return null;
}

/**
 * The `"."` target of an `exports` field: a bare string, a conditions object,
 * or a subpath map holding `"."`.
 */
function rootExport(exportsField: unknown): string | null {
	if (!isRecord(exportsField)) return resolveTarget(exportsField);
	const keys = Object.keys(exportsField);
	const isSubpathMap = keys.some((key) => key.startsWith("."));
	return resolveTarget(isSubpathMap ? exportsField["."] : exportsField);
}

/**
 * The package's own directory, found by walking up from its served `dist/` to
 * the `package.json` that names it.
 *
 * Not `import.meta.resolve(`${specifier}/package.json`)`: a package whose
 * `exports` does not list `./package.json` refuses that, and every `@c9up`
 * package is one of them.
 */
function findPackageJson(
	specifier: string,
	from: string,
): { root: string; manifest: Record<string, unknown> } | null {
	let dir = from;
	for (;;) {
		const file = join(dir, "package.json");
		if (existsSync(file)) {
			try {
				const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
				if (isRecord(manifest) && manifest.name === specifier) {
					return { root: dir, manifest };
				}
			} catch {
				// An unreadable manifest on the way up is not this package's.
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * The absolute file the importmap entry must point at, or `null` when the
 * package says nothing usable (no manifest found, no `exports`).
 */
function browserEntryFile(specifier: string, distRoot: string): string | null {
	const found = findPackageJson(specifier, distRoot);
	if (found === null) return null;
	const target = rootExport(found.manifest.exports);
	return target === null ? null : resolvePath(found.root, target);
}

/**
 * The importmap URL for `file`, which has to sit under the served `dist/`:
 * that directory is all the mount publishes.
 */
function entryUrl(
	specifier: string,
	assetPath: string,
	distRoot: string,
	file: string,
): string {
	const inDist = relative(distRoot, file);
	if (inDist === "" || inDist.startsWith("..") || isAbsolute(inDist)) {
		throw new Error(
			`[aurora] "${specifier}" declares its browser entry at "${file}", outside ` +
				`the directory aurora serves for it ("${distRoot}"). Map it yourself ` +
				`with \`importmap\` in config/aurora.ts, or ship the entry under dist/.`,
		);
	}
	return `${assetPath}/dist/${inDist.split(sep).join("/")}`;
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
	// Read out of the package's `exports`, never assumed: `dist/index.js` is
	// the NODE entry of a package that ships a separate browser build, and
	// mapping it left the page importing `node:fs`.
	const entryFile = browserEntryFile(specifier, distRoot);
	return {
		specifier,
		slug,
		assetPath,
		distRoot,
		// Probed rather than declared: a package gains or loses a wasm build
		// between releases, and a list here would be one more thing to keep in
		// step with packages aurora does not own.
		wasmRoot: existsSync(wasmCandidate) ? wasmCandidate : null,
		entry:
			entryFile === null
				? `${assetPath}/dist/index.js`
				: entryUrl(specifier, assetPath, distRoot, entryFile),
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
