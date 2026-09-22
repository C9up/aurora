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

import { AuroraError } from "./errors.js";
import { setOwner } from "./reactive.js";
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
	/** Values this component provided, by context key. Empty for most. */
	readonly provided: Map<symbol, unknown>;
}

const contextStack: ComponentContext[] = [];

function activeContext(): ComponentContext {
	const ctx = contextStack[contextStack.length - 1];
	if (!ctx) {
		throw new AuroraError(
			"E_AURORA_OUTSIDE_COMPONENT",
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
			provided: new Map(),
		};
		contextStack.push(ctx);
		// Own the reactive scope of setup: effects/memos created here register
		// their disposer into ctx.cleanups and tear down at unmount, instead of
		// leaking their signal subscriptions. Restored after setup so the outer
		// scope (or none) resumes. Save/restore handles nested component() calls.
		const prevOwner = setOwner(ctx.cleanups);
		try {
			const result = setup((props ?? ({} as P)) as P);
			return wrapWithLifecycle(result, ctx);
		} finally {
			setOwner(prevOwner);
			contextStack.pop();
		}
	};
}

/**
 * A value a component hands to its descendants without threading it through
 * every prop in between.
 *
 * Compound components need this: a `Select` owns the open state, the active
 * item and the ids, and its trigger, its content and each of its items all
 * read them. Passing that down explicitly means every level in between carries
 * props it does not use, and the composition stops looking like what it builds.
 *
 * ONE RULE, and it is the whole of the contract: a descendant sees the value
 * only if it is CREATED INSIDE the provider's setup. Aurora evaluates
 * eagerly — there is no JSX compiler deferring anything — so
 *
 *     Parent({ children: [Child()] })       // Child() ran BEFORE Parent's setup
 *
 * hands `Child` nothing, while
 *
 *     Parent({ children: () => [Child()] }) // Parent's setup calls it
 *
 * works, because the thunk runs while the provider is on the stack. A
 * component that provides anything therefore reads its children itself,
 * inside setup.
 */
export interface Context<T> {
	/** Identity. A symbol so two contexts never collide by name. */
	readonly key: symbol;
	/** Shown when nothing provided a value, and named in the error when there is none. */
	readonly name: string;
	readonly hasDefault: boolean;
	readonly defaultValue: T | undefined;
}

/**
 * Declare a context.
 *
 * With no default, `inject` throws when nothing provided one — which is what a
 * compound component wants: `SelectItem` outside a `Select` is a mistake, not
 * a case to handle.
 */
export function createContext<T>(name: string): Context<T>;
export function createContext<T>(name: string, defaultValue: T): Context<T>;
export function createContext<T>(name: string, ...rest: [T] | []): Context<T> {
	return {
		key: Symbol(name),
		name,
		hasDefault: rest.length > 0,
		defaultValue: rest[0],
	};
}

/**
 * Hand a value to everything created inside this component's setup.
 *
 * Returns the value, so the provider can keep using it in one statement.
 */
export function provide<T>(context: Context<T>, value: T): T {
	activeContext().provided.set(context.key, value);
	return value;
}

/**
 * Read the nearest provided value.
 *
 * Nearest wins: a `Select` inside a `DropdownMenu` shadows the menu's context
 * for its own subtree, which is what a reader of the markup would expect.
 */
export function inject<T>(context: Context<T>): T {
	for (let i = contextStack.length - 1; i >= 0; i -= 1) {
		const frame = contextStack[i];
		if (frame?.provided.has(context.key) === true) {
			return frame.provided.get(context.key) as T;
		}
	}
	if (context.hasDefault) return context.defaultValue as T;
	// Naming both halves, because the fix is almost always one of two things:
	// the component is used outside its parent, or its parent read its
	// children outside setup and the thunk rule was missed.
	throw new AuroraError(
		"E_AURORA_MISSING_CONTEXT",
		`No value provided for context "${context.name}". Either this component is used outside the one that provides it, or that one built its children outside its own setup — a provider must read its children itself, inside setup, or they are created before it exists.`,
	);
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
