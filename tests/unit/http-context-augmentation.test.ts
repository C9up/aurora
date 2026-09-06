/**
 * `ctx.aurora` has to exist for the compiler, not just at runtime.
 *
 * The `auroraContext` middleware attaches it, and the documentation teaches
 * `ctx.aurora.render(name, props)` as the way a controller renders a page. But
 * nothing declared the property, so that line did not typecheck: an application
 * following the docs had to fall back to the module-level
 * `aurora.render(ctx, ...)`, or assert its way past a property the framework
 * genuinely sets.
 *
 * A type-only failure is invisible to a runtime suite, so this is asserted by
 * compiling a snippet the way an application would.
 *
 * The augmentation ships on `@c9up/aurora/server`, not on the client barrel.
 * It names `@c9up/ream` — that is what a `declare module` for ream's types
 * requires — and doing so from the browser entry pulled ream's whole source
 * into every consumer's program, so a component library that imports nothing
 * but `component`/`html` was compiling ream's decorated console commands under
 * its own tsconfig and failing to build. Every application that renders a page
 * already imports the server barrel (that is where `auroraContext` and
 * `renderPage` live), and one import anywhere in the program carries the
 * augmentation to every file in it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
let scratch: string | undefined;

afterEach(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = undefined;
});

/** Typecheck `source` against this package, and hand back what tsc said. */
function typecheck(source: string): { ok: boolean; output: string } {
	// Inside the package: module resolution has to find `@c9up/ream` and this
	// package the way an application's would, which a directory outside the
	// tree cannot.
	scratch = mkdtempSync(path.join(packageRoot, ".augmentation-check-"));
	const file = path.join(scratch, "snippet.ts");
	writeFileSync(file, source);
	try {
		execFileSync(
			process.execPath,
			[
				path.join(packageRoot, "node_modules/typescript/bin/tsc"),
				"--noEmit",
				"--ignoreConfig",
				"--strict",
				"--module",
				"nodenext",
				"--moduleResolution",
				"nodenext",
				"--target",
				"es2022",
				"--skipLibCheck",
				"--experimentalDecorators",
				"--emitDecoratorMetadata",
				"--types",
				"node",
				"--lib",
				"es2022,dom",
				file,
			],
			{ cwd: packageRoot, encoding: "utf8", stdio: "pipe" },
		);
		return { ok: true, output: "" };
	} catch (error) {
		const shown = error as { stdout?: string; stderr?: string };
		return { ok: false, output: `${shown.stdout ?? ""}${shown.stderr ?? ""}` };
	}
}

describe("aurora > what the docs teach must typecheck", () => {
	it("accepts `ctx.aurora.render(name, props)` in a controller", () => {
		const result = typecheck(`
			import type { HttpContext } from '@c9up/ream'
			import '@c9up/aurora/server'

			export default class HomeController {
			  async index(ctx: HttpContext) {
			    await ctx.aurora?.render('Home', { greeting: 'hi' })
			  }
			}
		`);
		expect(result.output).toBe("");
		expect(result.ok).toBe(true);
	});

	it("carries the augmentation from anywhere in the program, not per file", () => {
		// What an application actually looks like: `start/kernel.ts` registers
		// `auroraContext` from the server barrel, and a controller elsewhere
		// imports only ream. One file bringing the server surface in is enough
		// for the whole program — which is why moving the augmentation off the
		// client barrel costs an application nothing.
		const result = typecheck(`
			import type { HttpContext } from '@c9up/ream'
			import { auroraContext } from '@c9up/aurora/server'

			export const middleware = [auroraContext]

			export async function show(ctx: HttpContext) {
			  await ctx.aurora?.render('Home', {})
			}
		`);
		expect(result.output).toBe("");
		expect(result.ok).toBe(true);
	});

	it("does not reach a browser bundle that imports only the client barrel", () => {
		// Deliberate, and the reason the whole file moved: naming ream from the
		// client entry drags ream's source into any package that imports aurora
		// for `component`/`html` alone.
		const result = typecheck(`
			import type { HttpContext } from '@c9up/ream'
			import '@c9up/aurora'

			export async function show(ctx: HttpContext) {
			  await ctx.aurora?.render('Home', {})
			}
		`);
		expect(result.ok).toBe(false);
		expect(result.output).toContain("'aurora' does not exist");
	});

	it("still refuses a property nothing attaches", () => {
		// The augmentation must add what the middleware sets, not open the
		// context to anything.
		const result = typecheck(`
			import type { HttpContext } from '@c9up/ream'
			import '@c9up/aurora'

			export function handler(ctx: HttpContext) {
			  return ctx.nothingSetsThis
			}
		`);
		expect(result.ok).toBe(false);
	});
}, 60_000);
