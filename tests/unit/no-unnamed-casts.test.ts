// @vitest-environment node
/**
 * `as` casts are banned in this codebase, and no lint rule catches one: Biome
 * flags `!` and `any`, not `as`. So this does. A cast that has to stay — a
 * branded overload, a value whose type is erased at a storage or module
 * boundary — says why in a `NAMED CAST:` comment just above it; any other is a
 * guard or a predicate waiting to be written.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "..", "src");

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			out.push(path);
		}
	}
	return out;
}

/** Every `x as T` (not `as const`) with no `NAMED CAST:` in the lines above it. */
function unnamedCasts(path: string): string[] {
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n");
	const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
			node.type.getText(file) !== "const"
		) {
			const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
			const above = lines.slice(Math.max(0, line - 6), line + 1).join("\n");
			if (!above.includes("NAMED CAST:")) {
				found.push(`${relative(SRC, path)}:${line + 1} ${node.getText(file)}`);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

describe("aurora > src has no unnamed cast", () => {
	it("narrows with guards, and names every cast it keeps", () => {
		const found = sourceFiles(SRC).flatMap(unnamedCasts);
		expect(found).toEqual([]);
	});

	it("finds a cast when there is one", () => {
		// The check above passing proves nothing if it cannot see one.
		const probe = ts.createSourceFile(
			"probe.ts",
			"const a = b as string; const c = d as const;",
			ts.ScriptTarget.Latest,
			true,
		);
		const casts: string[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isAsExpression(node) && node.type.getText(probe) !== "const") {
				casts.push(node.getText(probe));
			}
			ts.forEachChild(node, visit);
		};
		visit(probe);
		expect(casts).toEqual(["b as string"]);
	});
});
