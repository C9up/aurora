import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { html, renderToString } from "../../src/index.js";
import { Pages } from "../../src/server.js";

const FIXTURES = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../fixtures/pages",
);

describe("aurora > Pages > resolve", () => {
	it("returns the registered factory when one was set explicitly", async () => {
		const pages = new Pages({ root: FIXTURES });
		pages.register(
			"Greeting",
			(props: { name: string }) => html`<span>${props.name}</span>`,
		);
		const factory = await pages.resolve("Greeting");
		const out = renderToString(await factory({ name: "Hugo" }));
		expect(out).toBe("<span><!--$-->Hugo<!--/$--></span>");
	});

	it("imports a page from disk when no explicit registration exists", async () => {
		const pages = new Pages({ root: FIXTURES });
		const factory = await pages.resolve("Hello");
		const out = renderToString(await factory({ name: "World" }));
		expect(out).toBe('<p data-name="World">Hello, <!--$-->World<!--/$-->!</p>');
	});

	it("throws when the page module lacks a default export function", async () => {
		const pages = new Pages({ root: FIXTURES });
		await expect(pages.resolve("no-default")).rejects.toThrow(
			/must default-export a factory function/,
		);
	});

	it("throws when the page does not exist on disk", async () => {
		const pages = new Pages({ root: FIXTURES });
		await expect(pages.resolve("Missing")).rejects.toThrow(/not found/);
	});

	it("rejects path-traversal page names", async () => {
		const pages = new Pages({ root: FIXTURES });
		await expect(pages.resolve("../../etc/passwd")).rejects.toThrow(
			/illegal page name/,
		);
		await expect(pages.resolve("/abs/path")).rejects.toThrow(
			/illegal page name/,
		);
		await expect(pages.resolve("")).rejects.toThrow(/illegal page name/);
	});
});

describe("aurora > Pages > urlFor", () => {
	it("builds a default `/_assets/pages/Name.js` URL", () => {
		const pages = new Pages({ root: FIXTURES });
		expect(pages.urlFor("ProjectPage")).toBe("/_assets/pages/ProjectPage.js");
	});

	it("honors a custom urlPrefix + extension", () => {
		const pages = new Pages({
			root: FIXTURES,
			urlPrefix: "/static/pages/",
			extension: ".mjs",
		});
		expect(pages.urlFor("Foo")).toBe("/static/pages/Foo.mjs");
	});

	it("rejects unsafe names just like resolve()", () => {
		const pages = new Pages({ root: FIXTURES });
		expect(() => pages.urlFor("../boom")).toThrow(/illegal page name/);
	});
});

async function setupHotReloadTmp(label: string): Promise<{
	root: string;
	cleanup: () => void;
}> {
	const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
	const { join } = await import("node:path");
	// Stay UNDER the test fixtures root — vitest's ESM loader doesn't
	// resolve `/tmp` paths (its transform pipeline is rooted at the
	// project tree). A sibling of `tests/fixtures/` keeps imports
	// working AND inherits the workspace's `type: "module"` from the
	// nearest package.json above (no need to write one ourselves).
	const root = join(
		FIXTURES,
		"..",
		`_hot-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(root, { recursive: true });
	void writeFileSync;
	return {
		root,
		cleanup: () => {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("aurora > Pages > hot-reload (dev only)", () => {
	it("picks up disk changes between resolve() calls when NODE_ENV !== 'production'", async () => {
		const { writeFileSync, utimesSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { root, cleanup } = await setupHotReloadTmp("dev");
		const prev = process.env.NODE_ENV;
		process.env.NODE_ENV = "development";
		try {
			const file = join(root, "Counter.js");
			writeFileSync(file, "export default () => 'A';\n");
			const pages = new Pages({ root, extension: ".js" });
			const v1 = await (await pages.resolve("Counter"))({});

			writeFileSync(file, "export default () => 'B';\n");
			const future = new Date(Date.now() + 5000);
			utimesSync(file, future, future);

			const v2 = await (await pages.resolve("Counter"))({});

			expect(v1).toBe("A");
			expect(v2).toBe("B");
		} finally {
			process.env.NODE_ENV = prev;
			cleanup();
		}
	});

	it("does NOT bust the cache in production (stable URL)", async () => {
		const { writeFileSync, utimesSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { root, cleanup } = await setupHotReloadTmp("prod");
		const prev = process.env.NODE_ENV;
		process.env.NODE_ENV = "production";
		try {
			const file = join(root, "Frozen.js");
			writeFileSync(file, "export default () => 'A';\n");
			const pages = new Pages({ root, extension: ".js" });
			const v1 = await (await pages.resolve("Frozen"))({});

			writeFileSync(file, "export default () => 'B';\n");
			const future = new Date(Date.now() + 5000);
			utimesSync(file, future, future);

			const v2 = await (await pages.resolve("Frozen"))({});

			expect(v1).toBe("A");
			expect(v2).toBe("A");
		} finally {
			process.env.NODE_ENV = prev;
			cleanup();
		}
	});
});
