/**
 * What makes a page pick up a change in something it IMPORTS, in dev.
 *
 * Two halves, and neither works alone:
 *
 * 1. {@link newestMtime} — the page's cache-busting token becomes the newest
 *    mtime anywhere under the pages root, not the page file's own. Without
 *    this, editing a layout leaves the page's key unchanged, so Node never
 *    re-imports it and never re-resolves anything it pulls in.
 *
 * 2. {@link registerDevPageHooks} — a resolution hook that stamps each import
 *    under that root with its own mtime. Without this, the re-imported page
 *    resolves its layout to a bare URL that is still in the cache.
 *
 * Both are dev-only. In production a page's sources do not change, and
 * per-request busting would leak: every distinct URL stays resident in the ESM
 * registry for the process lifetime.
 *
 * **Measured 2026-09-19, and it decides what this can and cannot do.** The
 * whole approach rests on Node keying modules by full URL, query included. That
 * holds under plain Node — importing `Page.js?v=1` then `Page.js?v=2` yields two
 * instances, and the second sees the edit. Under `tsx` it does NOT: its loader
 * normalises the query away, so both imports return the same instance and every
 * registered `resolve` hook is bypassed for a relative specifier. So under a
 * TypeScript runner this file changes nothing, including the page-level busting
 * that predates it, and the only reload left is restarting the process — which
 * is what a watcher is for, and why a dev script should watch the page sources
 * as well as the server's own.
 *
 * That is a property of the runner, not something this package can fix from
 * inside. It is written down here because the symptom — "my template edits do
 * nothing" — points at a file cache, and the last person to chase it went
 * looking in the static middleware.
 */

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The newest mtime under `root`, or `null` when it cannot be read.
 *
 * **Directories are skipped by name, not by a filter someone has to remember.**
 * `node_modules` and dot-directories are the two that would turn a per-render
 * walk of a page tree into a walk of a dependency tree; everything else under a
 * pages root is a page, a template or something one of them imports.
 *
 * Synchronous on purpose. It runs once per page render in dev, on a directory
 * of tens of files, and the alternative — awaiting a tree walk before every
 * import — buys nothing a developer can perceive while making the caller async
 * for a case production never takes.
 */
export function newestMtime(root: string): number | null {
	let newest: number | null = null;

	const walk = (directory: string, depth: number): void => {
		// A pages root nested twenty deep is a mistake, not a feature; the cap
		// is what keeps a symlink loop from becoming an infinite walk.
		if (depth > 20) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(full, depth + 1);
				continue;
			}
			try {
				const { mtimeMs } = statSync(full);
				if (newest === null || mtimeMs > newest) newest = mtimeMs;
			} catch {
				// Deleted mid-walk: it cannot be the newest thing that still exists.
			}
		}
	};

	walk(root, 0);
	return newest;
}

let registered = false;

/**
 * Register the resolution hooks, once per process.
 *
 * **Either extension, because this package is run both ways.** Installed, the
 * hooks are `dist/devPageHooks.js`; from a checkout under a TypeScript runner
 * they are `src/devPageHooks.ts`, and `module.register` resolves the URL it is
 * given literally rather than through that runner's extension mapping. Asking
 * for `.js` alone therefore worked for everybody consuming the package and for
 * nobody working ON it — the failure mode being that page reloading silently
 * stops improving.
 *
 * **A failure is reported, once, rather than swallowed.** The first version of
 * this caught everything and said nothing, so the registration threw
 * `ERR_MODULE_NOT_FOUND` and the only symptom was that templates went on not
 * reloading — which is the bug this file exists to fix, reproduced one level
 * up. Degrading is fine; degrading in silence is what costs an afternoon.
 */
export async function registerDevPageHooks(root: string): Promise<void> {
	if (registered) return;
	registered = true;
	try {
		// Imported here rather than at module scope so production never pays for
		// it: `Pages` only calls this when it is not in production.
		const { register } = await import("node:module");
		if (typeof register !== "function") return;

		const here = new URL(".", import.meta.url);
		const hooks = ["devPageHooks.js", "devPageHooks.ts"]
			.map((name) => new URL(name, here))
			.find((candidate) => existsSync(fileURLToPath(candidate)));
		if (hooks === undefined) {
			console.warn(
				"[aurora] page hooks not found beside devPageReload — a page will still reload when edited, but a template it imports will not",
			);
			return;
		}

		register(hooks, import.meta.url, { data: { root } });
	} catch (error) {
		console.warn(
			`[aurora] could not register the page reload hooks: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
