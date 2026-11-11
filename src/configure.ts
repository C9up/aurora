/**
 * `ream configure @c9up/aurora` — install the page renderer in one command.
 *
 * Writes the provider, which binds the manager and mounts the `/__assets`
 * server middleware; `config/aurora.ts`, which says where the pages live; and
 * the router middleware that puts `ctx.aurora` on each request, without which
 * a controller's `aurora.render(...)` reads undefined. The asset middleware is
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
	registerMiddleware(
		importPath: string,
		options?: { tier?: "server" | "router"; position?: "before" | "after" },
	): Promise<void>;
	makeUsingStub(
		stubsRoot: string,
		stubPath: string,
		state?: Record<string, string | number | boolean>,
		options?: { force?: boolean },
	): Promise<{ path: string; contents: string }>;
}

export async function configure(codemods: Codemods): Promise<void> {
	await codemods.addProvider("@c9up/aurora/provider");
	// FIRST on the router tier: the codemod appends by default, which would put
	// it after the application's own router middleware — and one of those that
	// renders a page through `ctx.aurora` (a guard showing a login page) would
	// find nothing there. It reads nothing from the request, so running ahead
	// of the body parser and the session costs nothing.
	await codemods.registerMiddleware("@c9up/aurora/middleware", {
		tier: "router",
		position: "before",
	});
	await codemods.makeUsingStub(stubsRoot, "config/aurora.stub");
}
