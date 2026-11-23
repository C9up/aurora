/**
 * `@c9up/aurora/core` and `@c9up/aurora/renderer` stay host-free.
 *
 * A native renderer loads them on a phone's JS engine, which has no DOM, no
 * Node module and no top-level await. The barrel `@c9up/aurora` cannot be that
 * entry: it re-exports the DOM renderer and the browser helpers. So the
 * import graph of these two entries is walked here, statically, and has to
 * stay clear of every module that reaches for a host. A new import that drags
 * one in fails this test before it fails on a device.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");

/**
 * Modules that need a host: the DOM renderer and compiler, hydration, the
 * browser helpers and clients, and the server's string renderer. A file that
 * declares `/// <reference lib="dom" … />` is caught even when it is not listed.
 */
const HOST_MODULES = new Set([
	"browser.ts",
	"compile.ts",
	"http.ts",
	"hydrate.ts",
	"liveClient.ts",
	"nodes.ts",
	"render.ts",
	"rpc.ts",
	"ssr.ts",
	"xsrf.ts",
]);

/**
 * Packages these entries may import: `@c9up/flare`, the errors' base class,
 * which is one module with no import and no host API (`Error.captureStackTrace`
 * is read only where the engine has it).
 */
const HOST_FREE_PACKAGES = new Set(["@c9up/flare"]);

/** Value imports and re-exports; `import type` / `export type` are erased. */
const VALUE_IMPORT =
	/^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;

function graphOf(entry: string): Map<string, string> {
	const seen = new Map<string, string>();
	const pending = [join(SRC, entry)];
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		if (seen.has(file)) continue;
		const source = readFileSync(file, "utf8");
		seen.set(file, source);
		for (const match of source.matchAll(VALUE_IMPORT)) {
			const specifier = match[1] ?? "";
			if (!specifier.startsWith(".")) {
				seen.set(`external:${specifier}`, "");
				continue;
			}
			pending.push(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
		}
	}
	return seen;
}

/** A line at column 0 that awaits: a top-level await, which Hermes cannot load. */
const TOP_LEVEL_AWAIT = /^(?:await\b|(?:const|let|var)\s[^\n=]*=\s*await\b)/m;

describe.each(["core.ts", "renderer.ts"])("the import graph of %s", (entry) => {
	const graph = graphOf(entry);
	const files = [...graph.keys()].filter((key) => !key.startsWith("external:"));

	it("reaches no module that needs a host", () => {
		const hosts = files
			.filter((file) => {
				const name = relative(SRC, file);
				return (
					HOST_MODULES.has(name) ||
					(graph.get(file) ?? "").includes('/// <reference lib="dom"')
				);
			})
			.map((file) => relative(SRC, file));
		expect(hosts).toEqual([]);
	});

	it("imports no package and no Node module", () => {
		const externals = [...graph.keys()]
			.filter((key) => key.startsWith("external:"))
			.map((key) => key.slice("external:".length))
			.filter((specifier) => !HOST_FREE_PACKAGES.has(specifier));
		expect(externals).toEqual([]);
	});

	it("has no top-level await", () => {
		const awaiting = files
			.filter((file) => TOP_LEVEL_AWAIT.test(graph.get(file) ?? ""))
			.map((file) => relative(SRC, file));
		expect(awaiting).toEqual([]);
	});
});
