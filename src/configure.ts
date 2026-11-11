/**
 * `ream configure @c9up/aurora` — install the page renderer in one command.
 *
 * Writes the two lines every package's setup writes: the provider, which binds
 * the manager and mounts the `/__assets` server middleware, and
 * `config/aurora.ts`, which says where the pages live. The asset middleware is
 * not registered here: the provider installs it from `start()`, which runs
 * before the application's kernel, so it sits ahead of every app middleware
 * without depending on where a codemod puts a line.
 */

import { stubsRoot } from "./stubs.js";

/**
 * The subset of the CLI's codemods this hook uses, declared structurally: the
 * CLI injects the object at runtime, and aurora does not depend on ream.
 */
interface Codemods {
	addProvider(importPath: string): Promise<void>;
	makeUsingStub(
		stubsRoot: string,
		stubPath: string,
		state?: Record<string, string | number | boolean>,
		options?: { force?: boolean },
	): Promise<{ path: string; contents: string }>;
}

export async function configure(codemods: Codemods): Promise<void> {
	await codemods.addProvider("@c9up/aurora/provider");
	await codemods.makeUsingStub(stubsRoot, "config/aurora.stub");
}
