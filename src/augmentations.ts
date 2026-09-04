/**
 * Teach ream's `ContainerBindings` what `container.make(...)` returns for the
 * tokens aurora binds.
 *
 * ream declares that interface open on purpose: it registers its own entries
 * and expects each package to contribute the ones it owns. Nothing filled
 * these in, so resolving by the string token answered `unknown` and every call
 * site had to assert a type it could not prove.
 *
 * Loaded from the package barrel, so importing Aurora anywhere in the
 * application is enough — nobody writes a `declare module` of their own.
 *
 * Type-only, and ream stays an OPTIONAL peer: nothing here reaches a runtime
 * import, and a `declare module` for a specifier that does not resolve is
 * simply inert.
 */

// Referenced so the augmentations below resolve the modules they augment.
import type {} from "@c9up/ream";
import type {} from "@c9up/ream/types";

import type { AuroraManager } from "./AuroraManager.js";
import type { AuroraRequestRenderer } from "./middleware.js";

declare module "@c9up/ream/types" {
	interface ContainerBindings {
		/** The Aurora manager, bound by `AuroraProvider`. */
		aurora: AuroraManager;
	}
}

declare module "@c9up/ream" {
	interface HttpContext {
		/**
		 * Render a page for THIS request — `ctx.aurora.render(name, props)`.
		 *
		 * Attached by the `auroraContext` middleware, which is what the docs tell
		 * an application to register. Without this declaration the property the
		 * middleware sets did not exist as far as the compiler was concerned, so
		 * the shorthand the documentation teaches did not typecheck, and a
		 * controller had to reach for the module-level `aurora.render(ctx, ...)`
		 * or assert its way past it.
		 *
		 * Optional, because the middleware is: an application that never
		 * registers it has no `ctx.aurora`, and saying otherwise would let a
		 * controller call something that is not there.
		 */
		aurora?: AuroraRequestRenderer;
	}
}
