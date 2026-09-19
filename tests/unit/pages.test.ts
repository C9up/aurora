import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { html, renderToString } from "../../src/index.js";
import { Pages, pageImportError } from "../../src/server.js";

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
	it("builds a default `/__assets/pages/Name.js` URL", () => {
		const pages = new Pages({ root: FIXTURES });
		expect(pages.urlFor("ProjectPage")).toBe("/__assets/pages/ProjectPage.js");
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

describe("aurora > Pages > why an import failed", () => {
	// Every failure used to be reported as "page not found", against the page's
	// own path — the one file guaranteed to be present. These three cases are
	// distinguishable, and the message has to distinguish them, because the
	// reader goes wherever it points.

	/** The rejection, or a failure saying the call unexpectedly succeeded. */
	async function rejection(promise: Promise<unknown>): Promise<Error> {
		try {
			await promise;
		} catch (err) {
			if (err instanceof Error) return err;
			throw new Error(`expected an Error, got ${typeof err}`);
		}
		throw new Error("expected resolve() to reject, but it succeeded");
	}

	async function pageDir(label: string) {
		const { writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { root, cleanup } = await setupHotReloadTmp(label);
		return {
			root,
			cleanup,
			write: (file: string, source: string) => {
				writeFileSync(join(root, file), source);
			},
		};
	}

	it("says 'not found' only when the PAGE is the missing module", async () => {
		const { root, cleanup } = await pageDir("absent");
		try {
			const pages = new Pages({ root, extension: ".js" });
			await expect(pages.resolve("Ghost")).rejects.toThrow(/not found/);
		} finally {
			cleanup();
		}
	});

	it("does not call a page 'not found' when a module it imports is the missing one", async () => {
		const { root, cleanup, write } = await pageDir("missing-dep");
		try {
			// Node names the page here too — as the IMPORTER ("imported from
			// <page>"). A substring check would have mis-sorted this case.
			write(
				"Pocket.js",
				"import { x } from './services.js';\nexport default () => x;\n",
			);
			const pages = new Pages({ root, extension: ".js" });
			const error = await rejection(pages.resolve("Pocket"));
			expect(error.message).not.toMatch(/not found/);
			expect(error.message).toMatch(/module graph failed/);
			expect(error.message).toContain("services.js");
		} finally {
			cleanup();
		}
	});

	it("names the stale-cache trap for a link-time missing export, in dev only", () => {
		// Vitest cannot stage this end-to-end: Vite's SSR transform rewrites
		// imports into property accesses, so a missing export reads as
		// `undefined` and the module links fine. The link-time SyntaxError below
		// is the verbatim shape a real Node process raises (measured, not
		// recalled), so the classification is what is under test here.
		const linkError = new SyntaxError(
			"The requested module './services.js' does not provide an export named 'amountParts'",
		);
		// A page that really is on disk: the whole point is that the page is
		// present and something it imports is what broke.
		const page = resolve(FIXTURES, "Hello.js");

		const dev = pageImportError("Hello", page, linkError, true);
		expect(dev.message).not.toMatch(/not found/);
		expect(dev.message).toContain("./services.js");
		expect(dev.message).toMatch(/frozen in this process's ESM cache/);
		expect(dev.cause).toBe(linkError);

		// In production the page URL is not cache-busted either, so the hint
		// would be a wrong explanation rather than a helpful one.
		const prod = pageImportError("Hello", page, linkError, false);
		expect(prod.message).toContain("./services.js");
		expect(prod.message).not.toMatch(/ESM cache/);
	});

	it("keeps the original error as `cause` instead of flattening it to a string", async () => {
		const { root, cleanup, write } = await pageDir("cause");
		try {
			write("Broken.js", "export default () => {\n");
			const pages = new Pages({ root, extension: ".js" });
			const error = await rejection(pages.resolve("Broken"));
			// Flattening into the message loses the stack that points at the line.
			expect(error.cause).toBeInstanceOf(Error);
		} finally {
			cleanup();
		}
	});
});

describe("aurora > Pages > reloading what a page imports", () => {
	/**
	 * **Editing a page reloaded; editing what it imports did not.**
	 *
	 * The cache-busting query was stamped with the page file's own mtime, so a
	 * change to a layout left the page's URL identical — Node served the cached
	 * module and never re-resolved its imports. From the outside that reads as
	 * the server caching files, which sent at least one person looking at the
	 * static middleware instead.
	 *
	 * The two halves are tested where they are pure. The reload ITSELF is a
	 * property of Node's module registry, not of this package: vitest resolves
	 * dynamic imports itself and does not honour a `file://` URL carrying a
	 * query, so an end-to-end assertion here would be testing the runner. It is
	 * verified against a real node process instead — see the package notes.
	 */
	it("takes its token from the newest file in the tree, not the page", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { newestMtime } = await import("../../src/devPageReload.js");

		const root = mkdtempSync(join(tmpdir(), "aurora-mtime-"));
		writeFileSync(join(root, "Page.js"), "export default () => null\n", "utf8");
		const before = newestMtime(root);
		expect(before).not.toBeNull();

		// A nested file, written later: a layout is what a page imports, and it
		// is the case the old token could not see.
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(root, "templates"));
		await new Promise((done) => setTimeout(done, 25));
		writeFileSync(join(root, "templates", "Layout.js"), "export const a = 1\n", "utf8");

		const after = newestMtime(root);
		expect(after).not.toBeNull();
		expect(after as number).toBeGreaterThan(before as number);
	});

	it("stamps an import under the root, and leaves everything else alone", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { pathToFileURL } = await import("node:url");
		const hooks = await import("../../src/devPageHooks.js");

		const root = mkdtempSync(join(tmpdir(), "aurora-hook-"));
		const inside = join(root, "Layout.js");
		writeFileSync(inside, "export const a = 1\n", "utf8");
		hooks.initialize({ root });

		const passthrough = (url: string) => async () => ({ url, format: "module" });

		// A module the page imports: it gets its own mtime, so it re-imports when
		// IT changes and stays cached when it does not.
		const stamped = await hooks.resolve("./Layout.js", { conditions: [], importAttributes: {} }, passthrough(pathToFileURL(inside).href));
		expect(stamped.url).toMatch(/\?v=\d/);

		/**
		 * A URL `Pages` has already versioned is left alone. It carries the
		 * NEWEST mtime in the tree — which is what makes the page re-import when
		 * a layout changes — and re-stamping it with the page's own mtime would
		 * reintroduce exactly the bug, one level up.
		 */
		const already = `${pathToFileURL(inside).href}?v=1`;
		expect((await hooks.resolve("./Layout.js", { conditions: [], importAttributes: {} }, passthrough(already))).url).toBe(already);

		// And nothing outside the pages root is touched: node_modules is not a
		// place where an edit should invalidate anything.
		const outside = pathToFileURL(join(tmpdir(), "elsewhere.js")).href;
		expect((await hooks.resolve("x", { conditions: [], importAttributes: {} }, passthrough(outside))).url).toBe(outside);
	});
});
