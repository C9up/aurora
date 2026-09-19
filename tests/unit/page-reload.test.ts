/**
 * Reloading a page's imports, end to end, in a real process.
 *
 * The two halves are unit-tested next door. What neither of those can show is
 * the thing that actually matters — that a second import of an edited tree
 * returns the edit — because proving it needs a module registry that has not
 * already been touched by a test runner. So this spawns a child.
 *
 * It is worth the child process. The belief that this cannot work under a
 * TypeScript runner was written into the source once, and it was wrong; a
 * silently failed hook registration is indistinguishable from a runner that
 * ignores hooks, and the only thing that tells them apart is running the whole
 * path and looking at what comes back.
 */

import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");

/**
 * `dist` when it exists, `src` otherwise.
 *
 * CI builds before it tests, so the child normally exercises the file an
 * application installs. From a checkout with no build it falls back to the
 * source, which Node reads directly from 22.18 on.
 */
function moduleUnderTest(): string {
	const built = join(packageRoot, "dist", "devPageReload.js");
	return existsSync(built)
		? built
		: join(packageRoot, "src", "devPageReload.ts");
}

const temporary: string[] = [];

afterEach(() => {
	while (temporary.length > 0) {
		const dir = temporary.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Render a page, edit the template it imports, render again.
 *
 * Returns both renders. The second is the whole question: it is the same page
 * file, untouched, and it must come back carrying the edit.
 */
async function renderEditRender(): Promise<{ first: string; second: string }> {
	const dir = mkdtempSync(join(tmpdir(), "aurora-reload-"));
	temporary.push(dir);
	const pages = join(dir, "pages");
	writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
	mkdirSync(pages);

	writeFileSync(join(pages, "layout.js"), 'export const label = "ORIGINAL";\n');
	writeFileSync(
		join(pages, "page.js"),
		'import { label } from "./layout.js";\nexport const render = () => label;\n',
	);

	const script = join(dir, "run.mjs");
	writeFileSync(
		script,
		`
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { newestMtime, registerDevPageHooks } from ${JSON.stringify(
			pathToFileURL(moduleUnderTest()).href,
		)};

const root = ${JSON.stringify(pages)};
await registerDevPageHooks(root);

const page = pathToFileURL(join(root, "page.js")).href;
const first = await import(\`\${page}?v=\${newestMtime(root)}\`);

// Only the template changes. The page file is left exactly as it was, which
// is the case that used to fail: its own mtime never moved.
writeFileSync(join(root, "layout.js"), 'export const label = "EDITED";\\n');

const second = await import(\`\${page}?v=\${newestMtime(root)}\`);
console.log(JSON.stringify({ first: first.render(), second: second.render() }));
`,
	);

	const { stdout } = await run(process.execPath, [script], { cwd: dir });
	const line = stdout.trim().split("\n").at(-1) ?? "";
	const parsed: unknown = JSON.parse(line);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof Reflect.get(parsed, "first") !== "string" ||
		typeof Reflect.get(parsed, "second") !== "string"
	) {
		throw new Error(`unreadable child output: ${stdout}`);
	}
	return {
		first: String(Reflect.get(parsed, "first")),
		second: String(Reflect.get(parsed, "second")),
	};
}

describe("aurora > page reload, end to end", () => {
	it("shows an edit to a template the page imports, without restarting", async () => {
		const { first, second } = await renderEditRender();
		expect(first).toBe("ORIGINAL");
		// Before the hooks existed this was still "ORIGINAL": the page
		// re-imported, and resolved its layout onto the URL already cached.
		expect(second).toBe("EDITED");
	}, 30_000);
});
