/**
 * Serving packages to the no-bundler browser.
 *
 * comet was one special case, chronos a second, atom would have been a third —
 * so what is under test is the mechanism, not the packages. What a package
 * needs: its `dist/` on a URL, its `wasm/` too when it has one (a SIBLING of
 * the dist, because a wasm-backed package imports `../wasm/…` and the bindgen
 * glue then fetches the binary beside itself), and an importmap entry pointing
 * INTO dist so that relative path lands on the sibling route rather than
 * climbing out of the mount. What it must not get is the package root, which
 * would answer both and also publish `index.*.node`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	resolveBrowserPackage,
	resolveBrowserPackages,
} from "../../src/browserPackage.js";
import { serveAssets } from "../../src/server.js";

describe("aurora > browser packages", () => {
	let pkgRoot: string;

	beforeEach(() => {
		pkgRoot = mkdtempSync(join(tmpdir(), "browser-pkg-"));
		mkdirSync(join(pkgRoot, "dist"), { recursive: true });
		writeFileSync(join(pkgRoot, "index.linux-x64-gnu.node"), "NATIVE");
	});
	afterEach(() => {
		rmSync(pkgRoot, { recursive: true, force: true });
	});

	it("points the importmap INTO dist, so `../wasm/` stays inside the mount", () => {
		const pkg = resolveBrowserPackage(
			"@c9up/atom",
			"/__assets",
			join(pkgRoot, "dist"),
		);
		expect(pkg?.entry).toBe("/__assets/atom/dist/index.js");
		// From the entry, the sibling import lands on the wasm route. Mapped at
		// the mount root instead, the same path would climb out of the prefix.
		expect(new URL("../wasm/g.js", `http://x${pkg?.entry}`).pathname).toBe(
			"/__assets/atom/wasm/g.js",
		);
	});

	function writeManifest(name: string, exportsField: unknown): void {
		writeFileSync(
			join(pkgRoot, "package.json"),
			JSON.stringify({ name, exports: exportsField }),
		);
	}

	it("maps the browser build a package declares, not its Node entry", () => {
		// rosetta's shape: `import` listed BEFORE `browser`, and the `import`
		// file reaches for a loader on disk. Mapping it left the page unable to
		// load the module at all.
		writeManifest("@c9up/rosetta", {
			".": {
				types: "./dist/index.d.ts",
				import: "./dist/index.js",
				browser: "./dist/index.browser.js",
			},
			"./provider": { import: "./dist/RosettaProvider.js" },
		});
		const pkg = resolveBrowserPackage(
			"@c9up/rosetta",
			"/__assets",
			join(pkgRoot, "dist"),
		);
		expect(pkg?.entry).toBe("/__assets/rosetta/dist/index.browser.js");
	});

	it("falls back to the import entry, then to dist/index.js", () => {
		writeManifest("@c9up/comet", {
			".": { types: "./dist/index.d.ts", import: "./dist/main.js" },
		});
		expect(
			resolveBrowserPackage("@c9up/comet", "/__assets", join(pkgRoot, "dist"))
				?.entry,
		).toBe("/__assets/comet/dist/main.js");

		// A package linked from a workspace exports TypeScript source, which no
		// browser runs: the convention stands.
		writeManifest("@c9up/comet", {
			".": { types: "./src/index.ts", import: "./src/index.ts" },
		});
		expect(
			resolveBrowserPackage("@c9up/comet", "/__assets", join(pkgRoot, "dist"))
				?.entry,
		).toBe("/__assets/comet/dist/index.js");

		// A package whose manifest says nothing usable keeps the convention.
		writeManifest("@c9up/comet", { "./client": "./dist/client.js" });
		expect(
			resolveBrowserPackage("@c9up/comet", "/__assets", join(pkgRoot, "dist"))
				?.entry,
		).toBe("/__assets/comet/dist/index.js");
	});

	it("reads nested conditions, a bare conditions object, and a string", () => {
		writeManifest("@c9up/atom", {
			browser: { import: "./dist/browser/index.js", default: "./x.js" },
			import: "./dist/index.js",
		});
		expect(
			resolveBrowserPackage("@c9up/atom", "/__assets", join(pkgRoot, "dist"))
				?.entry,
		).toBe("/__assets/atom/dist/browser/index.js");

		writeManifest("@c9up/atom", "./dist/atom.js");
		expect(
			resolveBrowserPackage("@c9up/atom", "/__assets", join(pkgRoot, "dist"))
				?.entry,
		).toBe("/__assets/atom/dist/atom.js");
	});

	it("only reads the manifest that names the package", () => {
		// A package.json further up that belongs to something else (the app,
		// a workspace root) must not decide this package's entry.
		writeManifest("some-app", { ".": { browser: "./dist/app.js" } });
		expect(
			resolveBrowserPackage("@c9up/comet", "/__assets", join(pkgRoot, "dist"))
				?.entry,
		).toBe("/__assets/comet/dist/index.js");
	});

	it("refuses a browser entry outside the served dist", () => {
		// The mount publishes dist/ and nothing else: mapping a file outside it
		// would hand the browser a URL that 404s.
		writeManifest("@c9up/atom", { ".": { browser: "./browser/index.js" } });
		expect(() =>
			resolveBrowserPackage("@c9up/atom", "/__assets", join(pkgRoot, "dist")),
		).toThrow(/outside the directory aurora serves/);
	});

	it("finds a wasm sibling when there is one, and reports none when there is not", () => {
		const without = resolveBrowserPackage(
			"@c9up/comet",
			"/__assets",
			join(pkgRoot, "dist"),
		);
		expect(without?.wasmRoot).toBeNull();

		mkdirSync(join(pkgRoot, "wasm"), { recursive: true });
		const with_ = resolveBrowserPackage(
			"@c9up/chronos",
			"/__assets",
			join(pkgRoot, "dist"),
		);
		expect(basename(String(with_?.wasmRoot))).toBe("wasm");
	});

	it("refuses a package whose entry sits at its root, which would publish all of it", () => {
		// playwright's shape: `./index.mjs` beside package.json, cli.js and the
		// rest. Its "dist" mount was the package root.
		writeFileSync(join(pkgRoot, "index.mjs"), "export default 1\n");
		writeManifest("@c9up/atom", { ".": { import: "./index.mjs" } });
		expect(() =>
			resolveBrowserPackage("@c9up/atom", "/__assets", pkgRoot),
		).toThrow(/package root/);
	});

	it("refuses a real installed package with a root-level entry", () => {
		expect(() => resolveBrowserPackage("playwright", "/__assets")).toThrow(
			/package root/,
		);
	});

	it("keeps serving a package whose entry is in a subdirectory", () => {
		writeManifest("@c9up/atom", { ".": { import: "./dist/index.js" } });
		const pkg = resolveBrowserPackage(
			"@c9up/atom",
			"/__assets",
			join(pkgRoot, "dist"),
		);
		expect(pkg?.distRoot).toBe(join(pkgRoot, "dist"));
		expect(pkg?.entry).toBe("/__assets/atom/dist/index.js");
	});

	it("only finds a wasm directory inside the package", () => {
		// dist/esm: `../wasm` is dist/wasm, inside the package.
		mkdirSync(join(pkgRoot, "dist", "esm"), { recursive: true });
		mkdirSync(join(pkgRoot, "dist", "wasm"), { recursive: true });
		writeManifest("@c9up/atom", { ".": { import: "./dist/esm/index.js" } });
		const inside = resolveBrowserPackage(
			"@c9up/atom",
			"/__assets",
			join(pkgRoot, "dist", "esm"),
		);
		expect(inside?.wasmRoot).toBe(join(pkgRoot, "dist", "wasm"));
	});

	it("skips a package that is not installed rather than failing the boot", () => {
		// Optional peers: an app that never imports chronos must not be made to
		// install it.
		expect(
			resolveBrowserPackage("@c9up/not-a-real-package", "/__assets"),
		).toBeNull();
		expect(
			resolveBrowserPackages(["@c9up/not-a-real-package"], "/__assets"),
		).toEqual([]);
	});

	it("refuses two packages that would mount on the same path", () => {
		// Serving both means one is unreachable, and which one would depend on
		// registration order.
		expect(() =>
			resolveBrowserPackages(["@scope-a/atom", "@scope-b/atom"], "/__assets", {
				"@scope-a/atom": join(pkgRoot, "dist"),
				"@scope-b/atom": join(pkgRoot, "dist"),
			}),
		).toThrow(/both mount on/);
	});

	it("serves a .wasm as application/wasm, which instantiateStreaming requires", async () => {
		// Not cosmetic: WebAssembly.instantiateStreaming REFUSES any other type,
		// and wasm-bindgen's glue calls it first.
		const root = mkdtempSync(join(tmpdir(), "wasm-root-"));
		try {
			writeFileSync(join(root, "e_bg.wasm"), Buffer.from([0, 97, 115, 109]));
			const headers: Record<string, string> = {};
			let sent: unknown;
			await serveAssets({ root })({
				request: { param: () => "e_bg.wasm" },
				response: {
					header(name: string, value: string) {
						headers[name.toLowerCase()] = value;
						return this;
					},
					status() {
						return this;
					},
					send(body: unknown) {
						sent = body;
					},
				},
			} as never);
			expect(Buffer.isBuffer(sent)).toBe(true);
			expect(headers["content-type"]).toBe("application/wasm");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
