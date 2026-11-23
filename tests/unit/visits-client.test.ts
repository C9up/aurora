/**
 * Page visits, the browser half: photon's client router driving aurora pages
 * (the real `@c9up/photon/client`, the pages from tests/fixtures/visit-pages).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { onPageLeave } from "../../src/pageLifecycle.js";
import { renderToString } from "../../src/ssr.js";
import { bootVisits } from "../../src/visits.js";
import Home, { ended } from "../fixtures/visit-pages/Home.js";

function bootDocument(component = "Home"): void {
	const page = {
		component,
		props: { title: "Welcome" },
		url: "/",
		framework: "aurora",
		version: "v1",
	};
	document.body.innerHTML = `<div id="aurora-root">${renderToString(Home({ title: "Welcome" }))}</div>
<script id="photon-data" type="application/json">${JSON.stringify(page)}</script>
<script id="aurora-page-data" type="application/json">${JSON.stringify({
		name: "Home",
		rootId: "aurora-root",
		routes: { home: "/" },
		modules: "/tests/fixtures/visit-pages/{name}.ts",
	})}</script>`;
	delete document.documentElement.dataset.photonRouterInstalled;
	history.replaceState(null, "", "/");
}

function click(link: Element, init: MouseEventInit = {}): MouseEvent {
	const event = new MouseEvent("click", {
		bubbles: true,
		cancelable: true,
		button: 0,
		...init,
	});
	link.dispatchEvent(event);
	return event;
}

const root = () => document.getElementById("aurora-root");

afterEach(() => {
	vi.unstubAllGlobals();
});

// The real photon client is imported and transpiled on first use: under
// coverage on a busy machine that alone took more than vitest's 5 s.
const SLOW = 20_000;

describe("aurora > visits > client", () => {
	it(
		"follows a plain link as a visit: the old page ends, the next renders into the root",
		async () => {
			bootDocument();
			await bootVisits();
			expect(root()?.querySelector("h1")?.textContent).toBe("Welcome");

			const left: string[] = [];
			onPageLeave(() => left.push("live component closed"));
			const fetchMock = vi.fn(
				async (_url: string, _init: RequestInit) =>
					new Response(
						JSON.stringify({
							component: "Second",
							props: { n: 2 },
							url: "/second",
							framework: "aurora",
							version: "v1",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			);
			vi.stubGlobal("fetch", fetchMock);
			const before = ended.count;

			const event = click(
				root()?.querySelector('a[href="/second"]') ?? document.body,
			);
			expect(event.defaultPrevented).toBe(true);
			await vi.waitFor(() =>
				expect(root()?.querySelector('[data-page="second"]')?.textContent).toBe(
					"Second 2",
				),
			);
			const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
			expect(headers.get("x-photon")).toBe("true");
			expect(headers.get("x-photon-version")).toBe("v1");
			expect(ended.count).toBe(before + 1);
			expect(left).toEqual(["live component closed"]);
			expect(location.pathname).toBe("/second");
			expect(root()?.querySelector('[data-page="home"]')).toBeNull();
		},
		SLOW,
	);

	it(
		"leaves to the browser what is not a visit",
		async () => {
			bootDocument();
			await bootVisits();
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			const external = click(
				root()?.querySelector('a[data-photon="external"]') ?? document.body,
			);
			expect(external.defaultPrevented).toBe(false);
			const modified = click(
				root()?.querySelector('a[href="/second"]') ?? document.body,
				{
					ctrlKey: true,
				},
			);
			expect(modified.defaultPrevented).toBe(false);
			expect(fetchMock).not.toHaveBeenCalled();
		},
		SLOW,
	);

	it("refuses to boot a page that carries no aurora-page-data", async () => {
		document.body.innerHTML = '<div id="aurora-root"></div>';
		await expect(bootVisits()).rejects.toMatchObject({
			code: "E_AURORA_VISIT_NO_PAGE_DATA",
		});
	});

	it(
		"refuses a page name that would climb out of the pages' URL prefix",
		async () => {
			bootDocument("../outside");
			await expect(bootVisits()).rejects.toMatchObject({
				code: "E_AURORA_ILLEGAL_PAGE_NAME",
			});
		},
		SLOW,
	);
});
