/**
 * Page visits through photon's protocol (`visits: true` in config/aurora.ts).
 *
 * After the first, server-rendered load, a link asks for the next page with
 * `X-Photon: true` and gets the page object as JSON — component, props, url,
 * version — which the client renders into the root without reloading the
 * document. The protocol has one implementation, photon's: the page object is
 * built by its `buildPageObject` (deferred, partial, merge, once props), and
 * the answers a visit gets instead of a page (409 on a stale version, 303
 * after a redirected mutation) by its `finishVisit`. aurora keeps its own
 * document, importmap and render scope.
 *
 * photon is an optional peer, loaded only when visits are on, by a specifier
 * no bundler resolves ahead of time; it is read structurally.
 */

import { E_AURORA_VISITS_NEED_PHOTON } from "../errors.js";

/** What a request says about the visit (photon's `PhotonRequestInfo`). */
export interface VisitRequestInfo {
	isPhotonRequest: boolean;
	method: string;
	version?: string;
	partial: unknown;
}

/** A page object, as photon builds it. */
export interface VisitPage {
	component: string;
	props: Record<string, unknown>;
	url: string;
	version: string;
	[extra: string]: unknown;
}

/** The part of `@c9up/photon` aurora uses. */
export interface VisitProtocol {
	readRequestInfo(ctx: unknown): VisitRequestInfo;
	readRequestUrl(ctx: unknown): string;
	buildPageObject(
		component: string,
		props: Record<string, unknown>,
		options: {
			url: string;
			version: string;
			framework: string;
			/** `readRequestInfo(ctx).partial`, handed back as photon read it. */
			partial?: unknown;
			sharedKeys?: readonly string[];
		},
	): Promise<{ page: VisitPage; rescuedErrors: readonly unknown[] }>;
	finishVisit(
		ctx: unknown,
		res: object,
		info: VisitRequestInfo,
		options: { url: string; version: string },
	): boolean;
	varyOnPhoton(res: object): void;
	shouldReloadForAssetVersion(info: VisitRequestInfo, version: string): boolean;
	/** The errors `buildPageObject` rescued, handed back as it returned them. */
	reportRescued(errors: readonly unknown[], ctx: undefined): void;
}

const MEMBERS = [
	"readRequestInfo",
	"readRequestUrl",
	"buildPageObject",
	"finishVisit",
	"varyOnPhoton",
	"shouldReloadForAssetVersion",
	"reportRescued",
] as const;

function isVisitProtocol(mod: unknown): mod is VisitProtocol {
	return (
		typeof mod === "object" &&
		mod !== null &&
		MEMBERS.every((name) => typeof Reflect.get(mod, name) === "function")
	);
}

/** The framework name aurora's pages carry: its client mounts them through photon's `bootPage`. */
export const VISIT_FRAMEWORK = "aurora";

// A variable, so a bundler of the app never pulls photon in ahead of time.
const PHOTON: string = "@c9up/photon";

/** Load photon's protocol, or say plainly why visits cannot run. */
export async function loadVisitProtocol(): Promise<VisitProtocol> {
	let mod: unknown;
	try {
		mod = await import(PHOTON);
	} catch (cause) {
		throw new E_AURORA_VISITS_NEED_PHOTON(
			[
				"visits are on (config/aurora.ts) but @c9up/photon is not installed: pnpm add @c9up/photon",
			],
			{ cause },
		);
	}
	if (!isVisitProtocol(mod)) {
		throw new E_AURORA_VISITS_NEED_PHOTON([
			"visits need @c9up/photon 0.1.25 or later (buildPageObject, finishVisit)",
		]);
	}
	return mod;
}
