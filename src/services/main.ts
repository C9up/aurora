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

const aurora: AuroraManager = new Proxy({} as AuroraManager, {
	get(_target, prop) {
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
