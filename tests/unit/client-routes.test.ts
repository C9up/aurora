import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuroraManager } from "../../src/AuroraManager.js";
import { html, urlFor } from "../../src/index.js";
import type { RenderHttpContext, RenderResponse } from "../../src/server.js";
import { Pages, renderPage } from "../../src/server.js";

/**
 * The named-route manifest a page carries is public: every visitor of /login
 * read the whole application's map — admin, internal and ops endpoints. The
 * client half can be filtered while the server keeps resolving against all
 * of it.
 */

const FIXTURES = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../fixtures/pages",
);

const MANIFEST = {
	"auth.login": "/login",
	"auth.logout": "/logout",
	"admin.users.impersonate": "/admin/users/:id/impersonate",
	"internal.billing.refund": "/internal/billing/:invoice/refund",
	"ops.debug.heapdump": "/__ops/heapdump",
};

function makeCtx(): { ctx: RenderHttpContext; body: () => string } {
	let body = "";
	const response: RenderResponse = {
		status() {
			return response;
		},
		header() {
			return response;
		},
		send(out: string) {
			body = out;
		},
	};
	return { ctx: { request: {}, response }, body: () => body };
}

/** The `routes` a rendered page carries in its public page data. */
function clientRoutes(markup: string): unknown {
	const match =
		/<script[^>]*id="aurora-page-data"[^>]*>([\s\S]*?)<\/script>/.exec(markup);
	const data: unknown = JSON.parse(match?.[1] ?? "{}");
	return Reflect.get(Object(data), "routes");
}

function loginPages(): Pages {
	const pages = new Pages({ root: FIXTURES });
	pages.register(
		"Login",
		() =>
			html`<form action="${urlFor("auth.login")}"><a href="${urlFor("admin.users.impersonate", { id: 1 })}">x</a></form>`,
	);
	return pages;
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("aurora > renderPage > client routes", () => {
	it("serializes only the routes `only` names, with wildcards", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { ctx, body } = makeCtx();
		await renderPage(
			ctx,
			loginPages(),
			"Login",
			{},
			{
				routes: MANIFEST,
				clientRoutes: { only: ["auth.*"] },
			},
		);
		expect(clientRoutes(body())).toEqual({
			"auth.login": "/login",
			"auth.logout": "/logout",
		});
		expect(body()).not.toContain("admin.users.impersonate");
		expect(body()).not.toContain("heapdump");
	});

	it("keeps resolving every route on the server", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { ctx, body } = makeCtx();
		await renderPage(
			ctx,
			loginPages(),
			"Login",
			{},
			{
				routes: MANIFEST,
				clientRoutes: { only: ["auth.login"] },
			},
		);
		expect(body()).toContain('href="/admin/users/1/impersonate"');
	});

	it("leaves out what `except` names", async () => {
		const { ctx, body } = makeCtx();
		await renderPage(
			ctx,
			loginPages(),
			"Login",
			{},
			{
				routes: MANIFEST,
				clientRoutes: { except: ["internal.*", "ops.*"] },
			},
		);
		expect(Object.keys(Object(clientRoutes(body())))).toEqual([
			"auth.login",
			"auth.logout",
			"admin.users.impersonate",
		]);
	});

	it("takes a predicate", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { ctx, body } = makeCtx();
		await renderPage(
			ctx,
			loginPages(),
			"Login",
			{},
			{
				routes: MANIFEST,
				clientRoutes: (name, pattern) =>
					name.startsWith("auth.") && !pattern.includes(":"),
			},
		);
		expect(Object.keys(Object(clientRoutes(body())))).toEqual([
			"auth.login",
			"auth.logout",
		]);
	});

	it("warns in development when the page used a route the client will not have", async () => {
		vi.stubEnv("NODE_ENV", "development");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { ctx } = makeCtx();
		await renderPage(
			ctx,
			loginPages(),
			"Login",
			{},
			{
				routes: MANIFEST,
				clientRoutes: { only: ["auth.*"] },
			},
		);
		const messages = warn.mock.calls.map((call: unknown[]) => String(call[0]));
		expect(messages.some((m) => m.includes("admin.users.impersonate"))).toBe(
			true,
		);
		expect(messages.some((m) => m.includes("auth.login"))).toBe(false);
	});

	it("does not warn in production", async () => {
		vi.stubEnv("NODE_ENV", "production");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { ctx } = makeCtx();
		await renderPage(
			ctx,
			loginPages(),
			"Login",
			{},
			{
				routes: MANIFEST,
				clientRoutes: { only: ["auth.*"] },
			},
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it("serializes every route when no filter is given", async () => {
		const { ctx, body } = makeCtx();
		await renderPage(ctx, loginPages(), "Login", {}, { routes: MANIFEST });
		expect(clientRoutes(body())).toEqual(MANIFEST);
	});

	it("reads the filter from the manager config, a per-call one winning", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const manager = new AuroraManager({
			pages: { root: FIXTURES },
			clientRoutes: { only: ["auth.login"] },
		});
		manager.pages.register("Login", () => html`<p>x</p>`);
		const fromConfig = makeCtx();
		await manager.render(fromConfig.ctx, "Login", {}, { routes: MANIFEST });
		expect(clientRoutes(fromConfig.body())).toEqual({ "auth.login": "/login" });

		const perCall = makeCtx();
		await manager.render(
			perCall.ctx,
			"Login",
			{},
			{
				routes: MANIFEST,
				clientRoutes: { only: ["ops.*"] },
			},
		);
		expect(clientRoutes(perCall.body())).toEqual({
			"ops.debug.heapdump": "/__ops/heapdump",
		});
	});
});
