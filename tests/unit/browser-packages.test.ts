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
