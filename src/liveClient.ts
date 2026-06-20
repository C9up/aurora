/**
 * Live client runtime (Stage 5) — the thin browser side of live components.
 *
 * It HYDRATES the server-rendered HTML with mirror signals (aurora's real
 * `hydrate`), then:
 *   - applies inbound patches by SETTING the mirror signal at the patched slot
 *     → aurora's fine-grained binding updates the exact DOM node (no bespoke
 *     DOM patcher; the isomorphic renderer IS the applier);
 *   - forwards interactions declared with `data-live-click="<event>"` to the
 *     server via the injected transport.
 *
 * Transport-agnostic: `subscribe` (relay SSE) and `post` (HTTP up) are injected,
 * so aurora never imports `@c9up/relay` or an HTTP client here. In an app, wire
 * `subscribe` to `@c9up/aurora/relay`'s `relay().subscribe` and `post` to an
 * `HttpClient`. Browser-only (uses the DOM) — part of the client barrel.
 */

import { hydrate } from "./hydrate.js";
import { isSignal } from "./reactive.js";
import type { SlotPatch } from "./live.js";
import type { TemplateResult } from "./types.js";

/** The transport the live client needs: a patch subscription + an event POST. */
export interface LiveClientTransport {
	/** Subscribe to a channel's patches (relay SSE). Returns an unsubscribe. */
	subscribe(channel: string, handler: (patch: SlotPatch[]) => void): () => void;
	/** Send a client event to the server (HTTP POST up). */
	post(id: string, event: string, payload?: unknown): void;
}

export interface LiveClientOptions {
	/** The element holding the server-rendered HTML to adopt. */
	container: Element;
	/** The client view (same template as the server; its signals are mirrors). */
	factory: () => TemplateResult;
	/** Ids from the server's mount response. */
	mount: { id: string; channel: string };
	transport: LiveClientTransport;
}

/**
 * Start the live client for one mounted component. Returns a disposer that
 * unsubscribes, removes the event listener, and tears down the hydration.
 *
 * Patches set writable signal slots; derived slots recompute locally from the
 * base signals they read (aurora re-evaluates them) — so the server's
 * base-signal patch is enough. (Derived-only slots with no mirrored base are an
 * étape-6 refinement.)
 *
 * Authoring rule (aurora hydration): a reactive text slot must be the SOLE
 * content of its element — write `Count: <span>${count}</span>`, not
 * `Count: ${count}`. SSR merges adjacent static+dynamic text into one node,
 * which hydration cannot re-split; isolating the slot keeps adopt + patch exact.
 */
export function liveClient(opts: LiveClientOptions): () => void {
	const view = opts.factory();
	const disposeHydrate = hydrate(opts.container, () => view);

	const off = opts.transport.subscribe(opts.mount.channel, (patch) => {
		for (const { slot, value } of patch) {
			const sig = view.values[slot];
			if (isSignal(sig)) (sig as (v: string) => void)(value);
		}
	});

	const onClick = (event: Event): void => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const el = target.closest("[data-live-click]");
		if (el) opts.transport.post(opts.mount.id, el.getAttribute("data-live-click") ?? "");
	};
	opts.container.addEventListener("click", onClick);

	return () => {
		off();
		opts.container.removeEventListener("click", onClick);
		disposeHydrate();
	};
}
