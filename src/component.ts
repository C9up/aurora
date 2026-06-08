/**
 * Component runtime.
 *
 *   const Counter = component<{ initial?: number }>(({ initial = 0 }) => {
 *     const count = signal(initial)
 *     onMount(() => { document.title = `Count: ${count()}` })
 *     return html`<button @click="${() => count(count() + 1)}">${count}</button>`
 *   })
 *
 * Setup runs **once** when the component is created (mount time).
 * `onMount` / `onUnmount` are bound to the per-component context active
 * during setup, so they see the right cleanup queue when the component
 * is unmounted later. State lives in plain `signal()` / `memo()` from
 * `./reactive.js` — there's no separate hook layer, and signals work
 * both inside and outside a component setup.
 *
 * Unlike React, there is no re-render — reactivity is push-based via the
 * signals the setup function captures. The compiled template is what
 * actually moves on screen.
 */

import type { Disposer } from "./render.js";
import type { EffectCallback, TemplateResult } from "./types.js";

/**
 * Active component context. `onMount` / `onUnmount` push into it so a
 * surrounding `render()` can dispose everything when the component
 * unmounts. The stack lets `component()` nest safely.
 */
interface ComponentContext {
	/** Cleanup functions to run at unmount. `onUnmount` pushes here. */
	readonly cleanups: Disposer[];
	/** Mount hooks queued via `onMount` — flushed after setup returns. */
	readonly mountHooks: Array<EffectCallback>;
}

const contextStack: ComponentContext[] = [];

function activeContext(): ComponentContext {
	const ctx = contextStack[contextStack.length - 1];
	if (!ctx) {
		throw new Error(
			"[aurora] onMount / onUnmount called outside component() — only valid inside a component setup function.",
		);
	}
	return ctx;
}

/**
 * Build a component factory. The returned function takes props and
 * produces a `TemplateResult` that can be rendered or nested inside
 * another template.
 *
 * `component()` does NOT itself mount anything — it composes. The
 * outermost `render(Component(props), container)` is what mounts.
 */
export function component<P = Record<string, never>>(
	setup: (props: P) => TemplateResult,
): (props?: P) => TemplateResult {
	return (props?: P) => {
		const ctx: ComponentContext = {
			cleanups: [],
			mountHooks: [],
		};
		contextStack.push(ctx);
		try {
			const result = setup((props ?? ({} as P)) as P);
			return wrapWithLifecycle(result, ctx);
		} finally {
			contextStack.pop();
		}
	};
}

/**
 * Stitch the component context onto the returned TemplateResult so the
 * outer renderer can flush mount hooks + register unmount cleanups
 * automatically when this slot is mounted / removed.
 *
 * The mechanism is a `Symbol`-keyed handoff: the renderer's text-slot
 * path (which handles nested TemplateResults) checks for this property
 * and forwards the lifecycle.
 */
const COMPONENT_LIFECYCLE: unique symbol = Symbol.for("aurora:component");

interface ComponentLifecycle {
	mountHooks: ReadonlyArray<EffectCallback>;
	cleanups: Disposer[];
}

function wrapWithLifecycle(
	result: TemplateResult,
	ctx: ComponentContext,
): TemplateResult {
	(result as { [COMPONENT_LIFECYCLE]?: ComponentLifecycle })[
		COMPONENT_LIFECYCLE
	] = {
		mountHooks: ctx.mountHooks,
		cleanups: ctx.cleanups,
	};
	return result;
}

/**
 * Internal — extract the lifecycle attachment a `component()` left on a
 * TemplateResult, if any. The renderer calls this after mounting the
 * fragment so onMount fires once the DOM is live, and the returned
 * cleanups bubble into the outer dispose chain.
 */
export function readComponentLifecycle(
	result: TemplateResult,
): ComponentLifecycle | undefined {
	return (result as { [COMPONENT_LIFECYCLE]?: ComponentLifecycle })[
		COMPONENT_LIFECYCLE
	];
}

// ─── Lifecycle ────────────────────────────────────────────────────

/**
 * Schedule a callback to run after the component is mounted into the
 * live document. Returning a function from `onMount` registers it as an
 * unmount cleanup.
 */
export function onMount(fn: EffectCallback): void {
	const ctx = activeContext();
	ctx.mountHooks.push(fn);
}

/**
 * Schedule a callback to run when the component unmounts. Equivalent
 * to the cleanup return of `onMount` but available without a paired
 * mount action.
 */
export function onUnmount(fn: () => void): void {
	const ctx = activeContext();
	ctx.cleanups.push(fn);
}
