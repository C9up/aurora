/**
 * The page data script, as the bootstraps find it. An element of the page
 * whose `id` and text come from data must not stand in for it, and the URL the
 * page modules are imported from stays on the page's own origin.
 */
import { afterEach, describe, expect, it } from "vitest";
import { html } from "../../src/html.js";
import { Pages } from "../../src/Pages.js";
import { PAGE_DATA_SELECTOR } from "../../src/pageData.js";
import { renderPage } from "../../src/server/renderPage.js";
import { loadVisitProtocol } from "../../src/server/visits.js";
import type { RenderHttpContext } from "../../src/server.js";
import { renderToString } from "../../src/ssr.js";
import { setRouteManifest, urlFor } from "../../src/url.js";
import { bootVisits } from "../../src/visits.js";

interface Post {
	slug: string;
	title: string;
}

// An anchored heading: the id and the text both come from what a visitor stored.
const PostPage = (props: { post: Post }) =>
	html`<article><h2 id="${props.post.slug}">${props.post.title}</h2>
		<a href="${() => urlFor("auth.login")}">Sign in</a></article>`;

const FORGED = JSON.stringify({
	rootId: "aurora-root",
	props: { post: { slug: "x", title: "forged props" } },
	routes: { "auth.login": "https://evil.example/login" },
	modules: "https://evil.example/{name}.js",
});

function fakeCtx(): { ctx: RenderHttpContext; body: () => string } {
	let sent = "";
	const ctx: RenderHttpContext = {
		request: { method: () => "GET", headers: {}, url: "/post" },
		response: {
			status: () => ctx.response,
			header: () => ctx.response,
			send: (body: string) => {
				sent = body;
			},
		},
	};
	return { ctx, body: () => sent };
}

function pages(): Pages {
	const registry = new Pages({ root: "/nonexistent" });
	registry.register("Post", PostPage);
	return registry;
}

/** What the inline bootstrap reads, run against the parsed document. */
function bootstrapData(doc: Document): unknown {
	return JSON.parse(doc.querySelector(PAGE_DATA_SELECTOR)?.textContent ?? "");
}

afterEach(() => {
	setRouteManifest({});
	Reflect.deleteProperty(globalThis, "__pageDataRan");
});

describe("aurora > page data", () => {
	it("is read from the script the server wrote, not from an element of the page", async () => {
		const { ctx, body } = fakeCtx();
		await renderPage(
			ctx,
			pages(),
			"Post",
			{ post: { slug: "aurora-page-data", title: FORGED } },
			{ routes: { "auth.login": "/login" } },
		);
		const out = body();
		const doc = new DOMParser().parseFromString(out, "text/html");
		// The selector the bootstrap runs is the one this test runs.
		expect(out).toContain(
			`document.querySelector(${JSON.stringify(PAGE_DATA_SELECTOR)})`,
		);
		expect(out).not.toContain("getElementById('aurora-page-data')");
		const data = bootstrapData(doc);
		expect(data).toMatchObject({
			name: "Post",
			props: { post: { slug: "aurora-page-data", title: FORGED } },
			routes: { "auth.login": "/login" },
		});
		// Written before the root: nothing the page renders comes first.
		const script = doc.querySelector(PAGE_DATA_SELECTOR);
		const root = doc.getElementById("aurora-root");
		expect(script?.nextElementSibling).toBe(root);
		// And the root is the first element with its id.
		expect(root?.parentElement?.tagName).toBe("BODY");
	});

	it("is not matched by an element that is not a JSON script", () => {
		document.body.innerHTML = `<div data-aurora-page type="application/json">{"x":1}</div>
<script type="text/plain" data-aurora-page>{"x":2}</script>
<script type="application/json" data-aurora-page>{"x":3}</script>`;
		expect(bootstrapData(document)).toEqual({ x: 3 });
	});

	it("writes photon's data and aurora's before the root, with visits on", async () => {
		const visits = await loadVisitProtocol();
		const { ctx, body } = fakeCtx();
		await renderPage(
			ctx,
			pages(),
			"Post",
			{ post: { slug: "aurora-page-data", title: FORGED } },
			{ visits },
		);
		const doc = new DOMParser().parseFromString(body(), "text/html");
		const first = doc.body.firstElementChild;
		expect(first?.id).toBe("photon-data");
		expect(first?.nextElementSibling?.matches(PAGE_DATA_SELECTOR)).toBe(true);
		expect(first?.nextElementSibling?.nextElementSibling?.id).toBe(
			"aurora-root",
		);
		expect(bootstrapData(doc)).toMatchObject({
			modules: "/__assets/pages/{name}.js",
		});
	});
});

describe("aurora > visits > page modules", () => {
	function bootDocument(modules: string): void {
		const post = { slug: "aurora-page-data", title: FORGED };
		const page = {
			component: "Post",
			props: { post },
			url: "/",
			framework: "aurora",
			version: "v1",
		};
		document.body.innerHTML = `<script id="photon-data" type="application/json">${JSON.stringify(page)}</script>
<script type="application/json" data-aurora-page>${JSON.stringify({
			name: "Post",
			rootId: "aurora-root",
			routes: {},
			modules,
		})}</script>
<div id="aurora-root">${renderToString(PostPage({ post }))}</div>`;
		delete document.documentElement.dataset.photonRouterInstalled;
		history.replaceState(null, "", "/");
	}

	it("refuses a module URL off the page's origin before importing it", async () => {
		for (const modules of [
			"https://evil.example/{name}.js",
			"//evil.example/{name}.js",
			"data:text/javascript,globalThis.__pageDataRan=1;export default()=>null//{name}",
			`${location.origin}//evil.example/{name}.js`,
		]) {
			bootDocument(modules);
			await expect(bootVisits(), modules).rejects.toMatchObject({
				code: "E_AURORA_VISIT_CROSS_ORIGIN_MODULE",
			});
		}
		expect(Reflect.get(globalThis, "__pageDataRan")).toBeUndefined();
	}, 20_000);
});
