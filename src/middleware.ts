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
	containerResolver?: { make(token: unknown): unknown };
	aurora?: AuroraRequestRenderer;
}

/** Structural check that a resolved value is render-capable (an AuroraManager). */
function isManager(value: unknown): value is AuroraManager {
	return (
		typeof value === "object" &&
		value !== null &&
		"render" in value &&
		typeof value.render === "function"
	);
}

function resolveManager(
	resolver: { make(token: unknown): unknown } | undefined,
): AuroraManager | undefined {
	try {
		const resolved = resolver?.make("aurora");
		return isManager(resolved) ? resolved : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Middleware: attach `ctx.aurora` for the request. No-op (passes through) when
 * the AuroraManager isn't registered, so it's safe to mount unconditionally.
 */
export function auroraContext(
	ctx: AuroraMiddlewareContext,
	next: () => Promise<void>,
): Promise<void> {
	const manager = resolveManager(ctx.containerResolver);
	if (manager) {
		ctx.aurora = {
			render: (name, props, options) =>
				manager.render(ctx, name, props, options),
		};
	}
	return next();
}
