/**
 * Default `AuroraManager` singleton — Adonis-style:
 *
 *   import aurora from '@c9up/aurora/services/main'
 *
 *   await aurora.render(ctx, 'ProjectPage', { project, tasks })
 *
 * Populated either by `AuroraProvider.boot()` (when the app uses
 * `() => import('@c9up/aurora/provider')`) or by the app itself via
 * `setAurora(myManager)`.
 */

import type { AuroraManager } from "../AuroraManager.js";

let instance: AuroraManager | undefined;

/** @internal Bind the singleton (called by AuroraProvider or by the app). */
export function setAurora(value: AuroraManager): void {
	instance = value;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function getAurora(): AuroraManager | undefined {
	return instance;
}

/**
 * @internal Release the singleton, so a shut-down application does not leave a
 * dead Aurora manager reachable through `services/main`.
 *
 * The caller checks ownership first (`getAurora() === mine`): two applications
 * share this module in one process, and the one shutting down must not clear
 * what the other has since bound.
 */
export function clearAurora(): void {
	instance = undefined;
}

const aurora: AuroraManager = new Proxy({} as AuroraManager, {
	get(_target, prop) {
		// A module loader inspects what it imports before anyone uses it: it reads
		// `then` to decide whether the namespace is thenable, and various symbols
		// for interop and formatting. Throwing on those turns a plain
		// `import { setX } from ".../services/main"` into a crash at import time,
		// far from any real use. They are not members of what this stands in for,
		// so answer undefined and let a genuine access be the one that reports.
		if (typeof prop === "symbol" || prop === "then") {
			return undefined;
		}
		if (!instance) {
			throw new Error(
				"[aurora] AuroraManager singleton accessed before AuroraProvider.boot() ran " +
					"or `setAurora(myManager)` was called. Wire one of them first.",
			);
		}
		const value = Reflect.get(instance, prop, instance);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default aurora;
