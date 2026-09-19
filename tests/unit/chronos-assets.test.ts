/**
 * Serving `@c9up/chronos` to the browser.
 *
 * comet is one directory and one importmap entry. chronos is not: its
 * `dist/native.js` reaches out with `import("../wasm/chronos_engine_wasm.js")`,
 * and wasm-bindgen's glue then fetches the binary beside itself. So the dist
 * alone answers 404 twice, and the package root would publish the five `.node`
 * binaries — server-only code, some 13 MB of it — over HTTP.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuroraManager } from "../../src/server.js";

describe("aurora > chronos assets", () => {
	let pkg: string;
	let manager: AuroraManager;

	beforeEach(() => {
		pkg = mkdtempSync(join(tmpdir(), "chronos-pkg-"));
		mkdirSync(join(pkg, "dist"), { recursive: true });
		mkdirSync(join(pkg, "wasm"), { recursive: true });
		writeFileSync(join(pkg, "index.linux-x64-gnu.node"), "NATIVE");
		manager = new AuroraManager({
			pages: { root: join(pkg, "pages") },
			chronosDistRoot: join(pkg, "dist"),
		});
	});
	afterEach(() => {
		rmSync(pkg, { recursive: true, force: true });
	});

	it("points the importmap INTO dist, so `../wasm/` stays inside the mount", () => {
		// The bare specifier must resolve to dist/index.js and not to the mount
		// root: from `/__assets/chronos/dist/native.js`, the `../wasm/x.js` it
		// imports lands on `/__assets/chronos/wasm/x.js` — the second route.
		// Mapped at the mount root instead, the same relative path would climb
		// out of the prefix entirely.
		expect(manager.chronosAssetPath).toBe("/__assets/chronos");
		expect(manager.chronosDistRoot).toBe(join(pkg, "dist"));
		const entry = `${manager.chronosAssetPath}/dist/index.js`;
		expect(new URL(entry, "http://x").pathname).toBe(
			"/__assets/chronos/dist/index.js",
		);
		expect(new URL("../wasm/g.js", `http://x${entry}`).pathname).toBe(
			"/__assets/chronos/wasm/g.js",
		);
	});

	it("resolves the wasm root as a SIBLING of the dist, not a child", () => {
		expect(manager.chronosWasmRoot).toBe(join(pkg, "wasm"));
		expect(basename(String(manager.chronosWasmRoot))).toBe("wasm");
	});

	it("offers a handler for each of the two roots", () => {
		expect(manager.chronosDistHandler()).toBeTypeOf("function");
		expect(manager.chronosWasmHandler()).toBeTypeOf("function");
	});

	it("serves nothing at all when chronos is not installed", () => {
		// The optional-peer case: no routes, no importmap entry, no error.
		const bare = new AuroraManager({ pages: { root: join(pkg, "pages") } });
		if (bare.chronosDistRoot === null) {
			expect(bare.chronosWasmRoot).toBeNull();
			expect(bare.chronosDistHandler()).toBeNull();
			expect(bare.chronosWasmHandler()).toBeNull();
		} else {
			// chronos IS installed in this workspace — then both must be there.
			expect(bare.chronosWasmRoot).not.toBeNull();
		}
	});
});

describe("aurora > serveAssets > wasm content type", () => {
	it("answers application/wasm, which instantiateStreaming requires", async () => {
		// Not cosmetic: `WebAssembly.instantiateStreaming` REFUSES any other
		// type, and wasm-bindgen's browser glue calls it first. Served as
		// octet-stream the module compiles nowhere.
		const { serveAssets } = await import("../../src/server.js");
		const root = mkdtempSync(join(tmpdir(), "wasm-root-"));
		try {
			writeFileSync(
				join(root, "engine_bg.wasm"),
				Buffer.from([0, 97, 115, 109]),
			);
			const handler = serveAssets({ root });
			const headers: Record<string, string> = {};
			let sent: unknown;
			await handler({
				request: { param: () => "engine_bg.wasm" },
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
			// The happy path leaves the status implicit and sends the bytes.
			expect(Buffer.isBuffer(sent)).toBe(true);
			expect(headers["content-type"]).toBe("application/wasm");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
