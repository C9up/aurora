/**
 * The module-resolution hooks that make a page's IMPORTS reloadable in dev.
 *
 * **The bug these exist for.** `Pages.resolve` busts the ESM cache for a page
 * by appending its own mtime, and says why: Node keys modules by URL, so a
 * stable URL freezes the first-imported version for the process lifetime. That
 * is right, and it covers exactly one file. A page's imports — the layout, the
 * organisms, the services it pulls in — resolve RELATIVE to that URL and come
 * out without a query, so they land on stable URLs that are already cached.
 * Editing a template therefore changed nothing until the process restarted,
 * while editing the page itself worked; the difference is invisible from the
 * outside and reads as "the server caches my files".
 *
 * So the query has to follow the imports, and the only place that can happen is
 * a resolution hook: Node hands every specifier through here before it consults
 * its cache.
 *
 * **An existing query is never replaced.** `Pages` stamps a page with the
 * NEWEST mtime in the whole tree — that is what makes a page re-import when a
 * file it imports changes — and stamping it again here with its own mtime would
 * undo exactly that. A child with no query gets its own mtime instead, so a
 * module nobody touched keeps its key and stays cached: one edit re-imports the
 * page and the file that changed, not the subtree.
 *
 * Dev only, and registered once — see `registerDevPageHooks`. In production the
 * registration never happens, so this file is never loaded.
 */

import { statSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";

interface ResolveContext {
	conditions: string[];
	importAttributes: Record<string, string>;
	parentURL?: string;
}

interface ResolveResult {
	url: string;
	format?: string | null;
	shortCircuit?: boolean;
	importAttributes?: Record<string, string>;
}

type NextResolve = (
	specifier: string,
	context: ResolveContext,
) => ResolveResult | Promise<ResolveResult>;

/** The pages directory, handed over at registration. */
let root: string | null = null;

export function initialize(data: { root?: unknown } | undefined): void {
	root =
		typeof data?.root === "string" && data.root.length > 0 ? data.root : null;
}

export async function resolve(
	specifier: string,
	context: ResolveContext,
	nextResolve: NextResolve,
): Promise<ResolveResult> {
	const result = await nextResolve(specifier, context);
	if (root === null || !result.url.startsWith("file:")) return result;

	// Already versioned by `Pages`: leave it. See the note above — replacing it
	// with this file's own mtime is precisely the bug, reintroduced one level up.
	if (result.url.includes("?")) return result;

	let path: string;
	try {
		path = fileURLToPath(result.url);
	} catch {
		return result;
	}
	if (!path.startsWith(root + sep)) return result;

	try {
		return { ...result, url: `${result.url}?v=${statSync(path).mtimeMs}` };
	} catch {
		// Gone between resolution and stat: hand back the plain URL and let the
		// import raise the real error rather than inventing one here.
		return result;
	}
}
