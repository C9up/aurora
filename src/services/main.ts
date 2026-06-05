/**
 * Default `AuroraManager` singleton — Adonis-style:
 *
 *   import aurora from '@c9up/aurora/services/main'
 *
 *   await aurora.render(ctx, 'ProjectPage', { project, tasks })
 *
 * Populated either by `AuroraProvider.boot()` (when the app uses
 * `() => import('@c9up/aurora/provider')`) or by the app itself via
 * `_setAurora(myManager)`.
 */

import type { AuroraManager } from "../AuroraManager.js";

let _instance: AuroraManager | undefined;

/** @internal Bind the singleton (called by AuroraProvider or by the app). */
export function _setAurora(instance: AuroraManager): void {
	_instance = instance;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function _getAurora(): AuroraManager | undefined {
	return _instance;
}

const aurora: AuroraManager = new Proxy({} as AuroraManager, {
	get(_target, prop) {
		if (!_instance) {
			throw new Error(
				"[aurora] AuroraManager singleton accessed before AuroraProvider.boot() ran " +
					"or `_setAurora(myManager)` was called. Wire one of them first.",
			);
		}
		const value = Reflect.get(_instance, prop, _instance);
		return typeof value === "function" ? value.bind(_instance) : value;
	},
});

export default aurora;
