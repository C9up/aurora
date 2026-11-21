/**
 * `auroraContext` — binds `ctx.aurora.render(name, props)` onto the request
 * context, the AdonisJS ctx-service idiom (the `ctx.view` / `ctx.inertia`
 * analog). Register it globally in your kernel; a thin controller then does:
 *
 *   async show({ aurora }: HttpContext) {
 *     return aurora.render('Dashboard', { user, stats })
 *   }
 *
 * Agnostic: it resolves the AuroraManager from the request container
 * (`ctx.containerResolver.make('aurora')`) — never imports `@c9up/ream` — and is
 * a no-op when no manager is registered. The module-level `aurora.render(ctx, …)`
 * service still works; this is the ctx-bound sugar.
 */

import type { AuroraManager } from "./AuroraManager.js";
import type {
	RenderHttpContext,
	RenderPageOptions,
} from "./server/renderPage.js";

/** The `ctx.aurora` surface — ctx-bound render (no explicit ctx argument). */
export interface AuroraRequestRenderer {
	render(
		name: string,
		props?: unknown,
		options?: RenderPageOptions,
	): Promise<void>;
}

/** Request context the middleware needs: render target + optional resolver/slot. */
interface AuroraMiddlewareContext extends RenderHttpContext {
	containerResolver?: { make(token: unknown): Promise<unknown> };
	aurora?: AuroraRequestRenderer;
}

/** Structural check that a resolved value is render-capable (an AuroraManager). */
/** What the middleware uses of the manager: `aroundVisit` only when visits exist. */
type ManagerSlice = Pick<AuroraManager, "render"> &
	Partial<Pick<AuroraManager, "aroundVisit">>;

function isManager(value: unknown): value is ManagerSlice {
	return (
		typeof value === "object" &&
		value !== null &&
		"render" in value &&
		typeof value.render === "function" &&
		(!("aroundVisit" in value) || typeof value.aroundVisit === "function")
	);
}

async function resolveManager(
	resolver: { make(token: unknown): Promise<unknown> } | undefined,
): Promise<ManagerSlice | undefined> {
	try {
		const resolved = await resolver?.make("aurora");
		return isManager(resolved) ? resolved : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Middleware: attach `ctx.aurora` for the request. No-op (passes through) when
 * the AuroraManager isn't registered, so it's safe to mount unconditionally.
 */
export async function auroraContext(
	ctx: AuroraMiddlewareContext,
	next: () => Promise<void>,
): Promise<void> {
	const manager = await resolveManager(ctx.containerResolver);
	if (manager) {
		ctx.aurora = {
			render: (name, props, options) =>
				manager.render(ctx, name, props, options),
		};
		// Visits on: the protocol's Vary, 409 and 303 around the request.
		if (manager.aroundVisit) return manager.aroundVisit(ctx, next);
	}
	return next();
}

/**
 * Default export — the middleware class a kernel imports lazily
 * (`router.use([() => import('@c9up/aurora/middleware')])`), which is how
 * `ream configure @c9up/aurora` registers it.
 */
export default class AuroraContextMiddleware {
	handle(
		ctx: AuroraMiddlewareContext,
		next: () => Promise<void>,
	): Promise<void> {
		return auroraContext(ctx, next);
	}
}
