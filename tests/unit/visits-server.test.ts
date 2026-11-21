/**
 * Page visits, the server half: photon's protocol answering aurora's pages.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defer } from "@c9up/photon";
import { describe, expect, it } from "vitest";
import { AuroraManager } from "../../src/AuroraManager.js";
import { AuroraError } from "../../src/errors.js";
import { loadVisitProtocol } from "../../src/server/visits.js";
import type { RenderHttpContext, RenderResponse } from "../../src/server.js";
import { Pages, renderPage } from "../../src/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = resolve(HERE, "../fixtures/pages");
// A stand-in for photon's built package (named build/: aurora's .gitignore drops dist/).
const PHOTON_DIST = resolve(HERE, "../fixtures/photon/build");

function makeCtx(headers: Record<string, string> = {}, method = "GET") {
	let body = "";
	let statusCode = 200;
	const sent = new Map<string, string>();
	const response: RenderResponse & { getStatus(): number } = {
		status(code: number) {
			statusCode = code;
			return response;
		},
		header(name: string, value: string) {
			sent.set(name.toLowerCase(), value);
			return response;
		},
		send(out: string) {
			body = out;
		},
		getStatus: () => statusCode,
	};
	const ctx: RenderHttpContext = {
		request: { method: () => method, headers, url: "/hello?x=1" },
		response,
	};
	return {
		ctx,
		body: () => body,
		header: (name: string) => sent.get(name),
		status: () => statusCode,
		setStatus: (code: number) => {
			statusCode = code;
		},
	};
}

/** The JSON a `<script id=…>` carries. */
function scriptJson(doc: string, id: string): unknown {
	const match = new RegExp(
		`<script id="${id}" type="application/json">([^<]*)</script>`,
	).exec(doc);
	if (!match?.[1]) throw new Error(`no ${id}`);
	return JSON.parse(match[1]);
}

describe("aurora > visits > server", () => {
	it("writes photon's page object into the first load, deferred props left for later", async () => {
		const visits = await loadVisitProtocol();
		const { ctx, body } = makeCtx();
		await renderPage(
			ctx,
			new Pages({ root: PAGES }),
			"Hello",
			{ name: "World", later: defer(() => 42) },
			{ visits, assetsVersion: "v3", title: "Hi <there>" },
		);
		const doc = body();
		// `<` escaped: no tag, and no way out of <title>.
		expect(doc).toContain("<title>Hi &lt;there></title>");
		expect(doc).toContain('data-name="World"');
		expect(scriptJson(doc, "photon-data")).toEqual({
			component: "Hello",
			props: { name: "World" },
			url: "/hello?x=1",
			framework: "aurora",
			version: "v3",
			deferredProps: { default: ["later"] },
			meta: { title: "Hi <there>" },
		});
		expect(scriptJson(doc, "aurora-page-data")).toMatchObject({
			name: "Hello",
			rootId: "aurora-root",
			modules: "/__assets/pages/{name}.js",
		});
		expect(doc).toContain("import { bootVisits } from '@c9up/aurora/visits'");
		expect(doc).not.toContain("hydrate(document.getElementById");
	});

	it("answers a visit with the page object alone, and a partial reload with what it asks", async () => {
		const visits = await loadVisitProtocol();
		const visit = makeCtx({ "x-photon": "true", "x-photon-version": "v3" });
		await renderPage(
			visit.ctx,
			new Pages({ root: PAGES }),
			"Hello",
			{ name: "Ada" },
			{
				visits,
				assetsVersion: "v3",
			},
		);
		expect(visit.header("content-type")).toMatch(/application\/json/);
		expect(visit.header("x-photon")).toBe("true");
		expect(JSON.parse(visit.body())).toEqual({
			component: "Hello",
			props: { name: "Ada" },
			url: "/hello?x=1",
			framework: "aurora",
			version: "v3",
		});

		const partial = makeCtx({
			"x-photon": "true",
			"x-photon-partial-component": "Hello",
			"x-photon-partial-data": "later",
		});
		await renderPage(
			partial.ctx,
			new Pages({ root: PAGES }),
			"Hello",
			{ name: "Ada", later: defer(() => 42) },
			{ visits },
		);
		expect(JSON.parse(partial.body()).props).toEqual({ later: 42 });
	});

	it("refuses props that are not an object", async () => {
		const visits = await loadVisitProtocol();
		const { ctx } = makeCtx();
		await expect(
			renderPage(ctx, new Pages({ root: PAGES }), "Hello", ["a"], { visits }),
		).rejects.toMatchObject({ code: "E_AURORA_VISIT_PROPS" });
	});

	it("maps photon's client, never its server entry, and answers a stale visit with a 409", async () => {
		const manager = new AuroraManager({
			pages: { root: PAGES },
			visits: true,
			photonDistRoot: PHOTON_DIST,
			assetsVersion: "v4",
		});
		const page = makeCtx();
		await manager.render(page.ctx, "Hello", { name: "World" });
		const doc = page.body();
		expect(doc).toContain(
			'"@c9up/photon/client":"/__assets/photon/dist/client/hydrate.js"',
		);
		// The router without adapters: what a page shared with the phone imports.
		expect(doc).toContain(
			'"@c9up/photon/client/core":"/__assets/photon/dist/client/core.js"',
		);
		expect(doc).toContain('"@c9up/aurora/visits":"/__assets/aurora/visits.js"');
		expect(doc).not.toContain('"@c9up/photon":');

		const stale = makeCtx({ "x-photon": "true", "x-photon-version": "v1" });
		await manager.aroundVisit(stale.ctx, async () => {
			await manager.render(stale.ctx, "Hello", { name: "X" });
			// No page for a client on an older build: the middleware answers it.
			expect(stale.body()).toBe("");
		});
		expect(stale.status()).toBe(409);
		expect(stale.header("x-photon-location")).toBe("/hello?x=1");
		expect(stale.header("vary")).toBe("X-Photon");

		const put = makeCtx({ "x-photon": "true" }, "PUT");
		await manager.aroundVisit(put.ctx, async () => put.setStatus(302));
		expect(put.status()).toBe(303);
	});

	it("says when visits are on but photon's client is not there", () => {
		expect(
			() =>
				new AuroraManager({
					pages: { root: PAGES },
					visits: true,
					photonDistRoot: resolve(HERE, "../fixtures/nowhere"),
				}),
		).toThrowError(AuroraError);
	});
});
