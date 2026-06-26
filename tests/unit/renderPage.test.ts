import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AuroraManager } from "../../src/AuroraManager.js";
import { booleanCookie, cookieState, html } from "../../src/index.js";
import type { RenderHttpContext, RenderResponse } from "../../src/server.js";
import { Pages, renderPage } from "../../src/server.js";

const FIXTURES = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../fixtures/pages",
);

function makeCtx(): {
	ctx: RenderHttpContext;
	getBody: () => string;
	getHeader: (name: string) => string | undefined;
} {
	let body = "";
	const headers = new Map<string, string>();
	let statusCode = 200;
	const response: RenderResponse = {
		status(code: number) {
			statusCode = code;
			return response;
		},
		header(name: string, value: string) {
			headers.set(name.toLowerCase(), value);
			return response;
		},
		send(out: string) {
			body = out;
		},
	};
	const ctx: RenderHttpContext = {
		request: {},
		response,
	};
	return {
		ctx,
		getBody: () => body,
		getHeader: (name) => headers.get(name.toLowerCase()),
	};
}

describe("aurora > renderPage", () => {
	it("returns a full HTML document with SSR body + hydration plumbing", async () => {
		const pages = new Pages({ root: FIXTURES });
		const { ctx, getBody, getHeader } = makeCtx();
		await renderPage(ctx, pages, "Hello", { name: "World" });
		const out = getBody();

		expect(getHeader("content-type")).toMatch(/text\/html/);
		expect(out).toMatch(/<!doctype html>/i);
		// SSR body was injected inside the aurora-root div.
		expect(out).toContain(
			'<div id="aurora-root"><p data-name="World">Hello, <!--$-->World<!--/$-->!</p></div>',
		);
		// Importmap maps @c9up/aurora to the default mount.
		expect(out).toContain('<script type="importmap">');
		expect(out).toContain('"@c9up/aurora":"/_assets/aurora/index.js"');
		// Bootstrap blob carries the props for the client.
		expect(out).toContain(
			'<script id="aurora-page-data" type="application/json">',
		);
		expect(out).toContain('"name":"Hello"');
		expect(out).toContain('"props":{"name":"World"}');
		// Hydration script imports aurora + the page and calls hydrate.
		expect(out).toContain(
			"import { hydrate, setRouteManifest } from '@c9up/aurora'",
		);
		expect(out).toContain('import Page from "/_assets/pages/Hello.js"');
		expect(out).toContain(
			"hydrate(document.getElementById(data.rootId), () => Page(data.props))",
		);
		// No routes passed → an empty manifest is still wired (no urlFor use).
		expect(out).toContain('"routes":{}');
	});

	it("injects the named-route manifest for the isomorphic urlFor()", async () => {
		const pages = new Pages({ root: FIXTURES });
		const { ctx, getBody } = makeCtx();
		await renderPage(
			ctx,
			pages,
			"Hello",
			{ name: "World" },
			{ routes: { "users.show": "/users/:id", "auth.login": "/login" } },
		);
		const out = getBody();
		// Manifest serialized into the page-data blob…
		expect(out).toContain('"users.show":"/users/:id"');
		expect(out).toContain('"auth.login":"/login"');
		// …and the bootstrap re-installs it before hydrating.
		expect(out).toContain("setRouteManifest(data.routes ?? {})");
	});

	it("AuroraManager.render points the importmap + page URL at the configured assetsPrefix", async () => {
		const manager = new AuroraManager({
			pages: { root: FIXTURES },
			assetsPrefix: "/assets",
		});
		const { ctx, getBody } = makeCtx();
		await manager.render(ctx, "Hello", { name: "World" });
		const out = getBody();
		expect(out).toContain('"@c9up/aurora":"/assets/aurora/index.js"');
		expect(out).toContain('import Page from "/assets/pages/Hello.js"');
	});

	it("auto-wires @c9up/comet into the importmap + asset path when comet is installed", async () => {
		const manager = new AuroraManager({ pages: { root: FIXTURES } });
		// comet is a (dev) dependency in this workspace, so it resolves.
		expect(manager.cometDistRoot).not.toBeNull();
		expect(manager.cometAssetPath).toBe("/_assets/comet");
		expect(manager.cometAssetsHandler()).not.toBeNull();
		const { ctx, getBody } = makeCtx();
		await manager.render(ctx, "Hello", { name: "World" });
		// The RPC client's bare `import '@c9up/comet'` resolves with zero app wiring.
		expect(getBody()).toContain('"@c9up/comet":"/_assets/comet/index.js"');
		// …and the RPC subpath itself is importmapped (no app-side entry needed).
		expect(getBody()).toContain('"@c9up/aurora/rpc":"/_assets/aurora/rpc.js"');
	});

	it("honors a custom importmap override + headExtra + rootId", async () => {
		const pages = new Pages({ root: FIXTURES });
		pages.register(
			"Custom",
			(props: { x: string }) => html`<span>${props.x}</span>`,
		);
		const { ctx, getBody } = makeCtx();
		await renderPage(
			ctx,
			pages,
			"Custom",
			{ x: "ok" },
			{
				importmap: { "preact-signals": "/cdn/preact-signals.js" },
				headExtra: "<title>Boom</title>",
				lang: "fr",
				rootId: "app",
			},
		);
		const out = getBody();
		expect(out).toMatch(/<html lang="fr">/);
		expect(out).toContain("<title>Boom</title>");
		expect(out).toContain('"preact-signals":"/cdn/preact-signals.js"');
		// Default aurora entry survives alongside the custom mapping.
		expect(out).toContain('"@c9up/aurora":"/_assets/aurora/index.js"');
		expect(out).toContain('<div id="app">');
		expect(out).toContain('"rootId":"app"');
	});

	it("escapes </script> sequences embedded in props (XSS guard)", async () => {
		const pages = new Pages({ root: FIXTURES });
		pages.register(
			"Echo",
			(props: { msg: string }) => html`<p>${props.msg}</p>`,
		);
		const { ctx, getBody } = makeCtx();
		await renderPage(ctx, pages, "Echo", {
			msg: "</script><script>alert(1)</script>",
		});
		const out = getBody();
		// The bootstrap JSON must NOT close the script prematurely.
		const dataBlock =
			out.match(
				/<script id="aurora-page-data"[^>]*>([\s\S]*?)<\/script>/,
			)?.[1] ?? "";
		expect(dataBlock).not.toContain("</script>");
		expect(dataBlock).toContain("<\\/script");
	});

	it("escapes </script> sequences embedded in the importmap (XSS guard)", async () => {
		const pages = new Pages({ root: FIXTURES });
		pages.register(
			"Plain",
			(props: { x: string }) => html`<span>${props.x}</span>`,
		);
		const { ctx, getBody } = makeCtx();
		await renderPage(
			ctx,
			pages,
			"Plain",
			{ x: "ok" },
			{
				// A "</script>" in a developer-supplied importmap value used to break
				// out of the element — the importmap went through raw JSON.stringify
				// while the page-data block was escaped (audit 2026-06-13).
				importmap: { evil: '/x.js"></script><script>alert(1)</script>' },
			},
		);
		const out = getBody();
		const mapBlock =
			out.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? "";
		expect(mapBlock).toContain("<\\/script");
	});

	it("seeds allowlisted request cookies so a page renders the right UI state in SSR", async () => {
		const pages = new Pages({ root: FIXTURES });
		// Mirrors fluveo's sidebar: a cookie-backed boolean drives the width class.
		pages.register("Sidebar", () => {
			const collapsed = cookieState("sidebar", false, booleanCookie);
			return html`<aside class="${() => (collapsed() ? "w-16" : "w-60")}"></aside>`;
		});
		const { ctx, getBody } = makeCtx();
		// A request that exposes only the cookies it was sent.
		const jar: Record<string, string> = { sidebar: "1", session: "secret" };
		ctx.request = { cookie: (name: string) => jar[name] ?? null };

		// Real SSR has no `document`; without this happy-dom's `document.cookie`
		// (empty) would shadow the seed and the test wouldn't exercise the path.
		vi.stubGlobal("document", undefined);
		try {
			await renderPage(ctx, pages, "Sidebar", {}, { cookies: ["sidebar"] });
		} finally {
			vi.unstubAllGlobals();
		}
		// SSR rendered the COLLAPSED width because the cookie was seeded — no flash.
		expect(getBody()).toContain('class="w-16"');
	});

	it("reads ONLY the allowlisted cookies (no session/leak) and never serializes them", async () => {
		const pages = new Pages({ root: FIXTURES });
		pages.register("Probe", () => {
			const collapsed = cookieState("sidebar", false, booleanCookie);
			return html`<aside class="${() => (collapsed() ? "w-16" : "w-60")}"></aside>`;
		});
		const { ctx, getBody } = makeCtx();
		const jar: Record<string, string> = { sidebar: "1", session: "secret" };
		ctx.request = { cookie: (name: string) => jar[name] ?? null };

		await renderPage(ctx, pages, "Probe", {}, { cookies: ["sidebar"] });
		const out = getBody();
		// The session cookie must NEVER appear in the HTML…
		expect(out).not.toContain("secret");
		// …and cookies are not serialized into the page-data blob at all.
		expect(out).not.toContain('"cookies"');
	});

	it("tolerates a request without cookie support (no allowlist match throws)", async () => {
		const pages = new Pages({ root: FIXTURES });
		pages.register("Plain2", () => html`<span>ok</span>`);
		const { ctx, getBody } = makeCtx(); // ctx.request === {}
		await expect(
			renderPage(ctx, pages, "Plain2", {}, { cookies: ["sidebar"] }),
		).resolves.toBeUndefined();
		expect(getBody()).toContain("<span>ok</span>");
	});
});
