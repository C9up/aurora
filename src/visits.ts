/**
 * The browser half of page visits (`visits: true` in config/aurora.ts).
 *
 * photon's client router drives the visits — following links, fetching the
 * next page object, history and back / forward, partial reloads, deferred
 * props, the full load a stale version asks for — and this is its adapter for
 * aurora pages: the first page is hydrated as before; each visit leaves the
 * page (its components' effects and unmount hooks, the live components it
 * opened), imports the next page's module once and renders it into the root.
 * What lives outside the root — module state, signals, the document's `<head>`
 * — stays.
 *
 * Links: every same-origin `<a href>` in the page is followed as a visit, as
 * photon follows its `data-photon` ones. `data-photon="external"` (or a
 * `target`, a `download`, a modified click) leaves one to the browser.
 */

import {
	E_AURORA_ILLEGAL_PAGE_NAME,
	E_AURORA_PAGE_INVALID_EXPORT,
	E_AURORA_VISIT_ASYNC_FIRST_PAGE,
	E_AURORA_VISIT_CROSS_ORIGIN_MODULE,
	E_AURORA_VISIT_NO_PAGE_DATA,
	E_AURORA_VISITS_NEED_PHOTON,
} from "./errors.js";
import { hydrate } from "./hydrate.js";
import { withIdScope } from "./id.js";
import { PAGE_DATA_SELECTOR } from "./pageData.js";
import { leavePage } from "./pageLifecycle.js";
import { render } from "./render.js";
import type { TemplateResult } from "./types.js";
import { setRouteManifest } from "./url.js";

type PageFactory = (
	props: Record<string, unknown>,
) => TemplateResult | Promise<TemplateResult>;

interface AdapterHandle {
	update(Component: unknown, props: Record<string, unknown>): void;
	unmount(): void;
}

/** The part of `@c9up/photon/client` aurora uses. */
interface PhotonClient {
	bootPage(options: {
		target: string;
		resolveComponent: (name: string) => Promise<{ default: unknown }>;
		mount(
			target: Element,
			Component: unknown,
			page: { props: Record<string, unknown> },
		): Promise<AdapterHandle>;
	}): Promise<void>;
	router: { visit(url: string): Promise<void> | void };
}

/** What aurora's document carries beside photon's page object. */
interface VisitData {
	rootId: string;
	routes: Record<string, string>;
	/** Where a page's module is, `{name}` standing for the page. */
	modules: string;
}

// A variable: the importmap resolves it in the browser, nothing bundles it.
const PHOTON_CLIENT: string = "@c9up/photon/client";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPhotonClient(mod: unknown): mod is PhotonClient {
	if (!isRecord(mod) || typeof mod.bootPage !== "function") return false;
	const router = mod.router;
	return isRecord(router) && typeof router.visit === "function";
}

function isPageFactory(value: unknown): value is PageFactory {
	return typeof value === "function";
}

function readData(): VisitData {
	// A JSON script only: an element of the page cannot stand in for it.
	const text = document.querySelector(PAGE_DATA_SELECTOR)?.textContent;
	const data: unknown = text ? JSON.parse(text) : null;
	if (
		!isRecord(data) ||
		typeof data.rootId !== "string" ||
		typeof data.modules !== "string" ||
		!data.modules.includes("{name}")
	) {
		throw new E_AURORA_VISIT_NO_PAGE_DATA();
	}
	const routes: Record<string, string> = {};
	if (isRecord(data.routes)) {
		for (const [name, pattern] of Object.entries(data.routes)) {
			if (typeof pattern === "string") routes[name] = pattern;
		}
	}
	return { rootId: data.rootId, routes, modules: data.modules };
}

/**
 * A page name as the server writes it: path segments, no `..`, no scheme or
 * query — so a name can only ever point under the pages' URL prefix.
 */
const PAGE_NAME = /^[\w.-]+(?:\/[\w.-]+)*$/;

async function importPage(
	modules: string,
	name: string,
): Promise<{ default: PageFactory }> {
	if (!PAGE_NAME.test(name) || name.split("/").includes("..")) {
		throw new E_AURORA_ILLEGAL_PAGE_NAME([name]);
	}
	const mod: unknown = await import(sameOriginModule(modules, name));
	const factory = isRecord(mod) ? mod.default : undefined;
	if (!isPageFactory(factory)) {
		throw new E_AURORA_PAGE_INVALID_EXPORT([`visits: page "${name}"`]);
	}
	return { default: factory };
}

/**
 * The URL a page module is imported from, refused unless it is on the page's
 * own origin and scheme.
 *
 * The pattern comes from the page data, and an import runs what it loads with
 * the page's authority. `https://other.example/{name}.js`, `//other.example/…`
 * and `data:text/javascript,…` all import code the server never served; a
 * `blob:` URL carries the page's origin but holds whatever was put in it.
 *
 * What is imported is the resolved PATH, not the URL: a specifier that starts
 * with ONE `/` cannot name another origin, whatever base it is resolved against.
 * A path that starts with two (`https://this.origin//other.example/x`) would be
 * read back as protocol-relative, so it is refused too.
 */
function sameOriginModule(modules: string, name: string): string {
	const url = new URL(modules.replace("{name}", name), location.href);
	if (
		url.origin !== location.origin ||
		url.protocol !== location.protocol ||
		url.pathname.startsWith("//")
	) {
		throw new E_AURORA_VISIT_CROSS_ORIGIN_MODULE();
	}
	return `${url.pathname}${url.search}${url.hash}`;
}

/** The adapter photon's router updates: one aurora page at a time in the root. */
function pageAdapter(
	target: Element,
	first: PageFactory,
	props: Record<string, unknown>,
	rootId: string,
): AdapterHandle {
	// Built inside hydrate, as the plain bootstrap does: its components mint
	// their ids in the root's scope, the one the server rendered them under.
	let dispose = hydrate(target, () => {
		const tree = first(props);
		if (tree instanceof Promise) {
			throw new E_AURORA_VISIT_ASYNC_FIRST_PAGE();
		}
		return tree;
	});
	let turn = 0;
	let shownUrl = location.href;
	const show = (result: TemplateResult): void => {
		target.replaceChildren();
		dispose = render(result, target);
		// A new address is a new page: start it at the top, as a full load
		// would. A partial reload of the same page keeps the reader's place.
		queueMicrotask(() => {
			if (location.href !== shownUrl) {
				shownUrl = location.href;
				window.scrollTo(0, 0);
			}
		});
	};
	return {
		update(Component, nextProps) {
			if (!isPageFactory(Component)) return;
			const mine = ++turn;
			// The old page ends before the new one starts: its effects, its
			// unmount hooks, the live components it opened.
			leavePage();
			dispose();
			const result = withIdScope(rootId, () => Component(nextProps));
			if (result instanceof Promise) {
				void result.then((resolved) => {
					if (mine === turn) show(resolved);
				});
			} else {
				show(result);
			}
		},
		unmount() {
			leavePage();
			dispose();
		},
	};
}

/** Follow same-origin links as visits (photon handles its `data-photon` ones itself). */
function followLinks(router: PhotonClient["router"]): void {
	document.addEventListener("click", (event) => {
		if (
			event.defaultPrevented ||
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey
		) {
			return;
		}
		const origin = event.target;
		if (!(origin instanceof Element)) return;
		const link = origin.closest("a[href]");
		if (!(link instanceof HTMLAnchorElement)) return;
		if (link.hasAttribute("data-photon") || link.hasAttribute("download"))
			return;
		if (link.target !== "" && link.target !== "_self") return;
		const url = new URL(link.href);
		if (url.origin !== location.origin) return;
		if (url.protocol !== "http:" && url.protocol !== "https:") return;
		// An anchor on this page scrolls; it is not a visit.
		const here = new URL(location.href);
		if (
			url.hash !== "" &&
			url.pathname === here.pathname &&
			url.search === here.search
		) {
			return;
		}
		event.preventDefault();
		void router.visit(url.pathname + url.search + url.hash);
	});
}

/** Boot the page with visits: hydrate it, then let photon's router take the next ones. */
export async function bootVisits(): Promise<void> {
	const data = readData();
	setRouteManifest(data.routes);
	const mod: unknown = await import(PHOTON_CLIENT);
	if (!isPhotonClient(mod)) {
		throw new E_AURORA_VISITS_NEED_PHOTON([
			"visits need @c9up/photon 0.1.25 or later (bootPage)",
		]);
	}
	await mod.bootPage({
		target: `#${CSS.escape(data.rootId)}`,
		resolveComponent: (name) => importPage(data.modules, name),
		mount: async (target, Component, page) => {
			if (!isPageFactory(Component)) {
				throw new E_AURORA_PAGE_INVALID_EXPORT([
					"visits: the first page module",
				]);
			}
			return pageAdapter(target, Component, page.props, data.rootId);
		},
	});
	followLinks(mod.router);
}
