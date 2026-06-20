/**
 * Live session registry (Stage 2) — the lifecycle layer for live components.
 *
 * Holds component DEFINITIONS by name (like the Pages registry), mounts a fresh
 * {@link LiveSession} per connected client, tracks ownership so every session a
 * client opened can be torn down at once on disconnect, and exposes lookup so
 * an inbound event reaches the right session.
 *
 * The transport stage drives it: connect → `mount(name, uid)`; event →
 * `get(id)?.dispatch(...)`; disconnect → `disposeOwner(uid)`. Transport-agnostic
 * and node-free (only `mountLiveSession` + `crypto.randomUUID`, both isomorphic).
 */

import {
	type LiveComponentDefinition,
	type LiveSession,
	mountLiveSession,
} from "./live.js";

/** A mounted instance: its id, the owner (e.g. relay uid), and the session. */
export interface LiveSessionHandle {
	id: string;
	ownerId: string;
	session: LiveSession;
}

export interface LiveRegistry {
	/** Register a live component definition under `name` (the "live class"). */
	define(name: string, factory: () => LiveComponentDefinition): void;
	/** True if `name` is registered. */
	has(name: string): boolean;
	/**
	 * Mount a fresh session of `name` owned by `ownerId`. Each call gets its own
	 * per-session signals. Throws if `name` is unknown — an unmountable component
	 * must fail loudly, never silently serve nothing.
	 */
	mount(name: string, ownerId: string): LiveSessionHandle;
	/** Look up a live session by instance id. */
	get(id: string): LiveSession | undefined;
	/** Dispose one session instance (frees its effects). */
	dispose(id: string): void;
	/** Dispose EVERY session a given owner opened — call on disconnect. */
	disposeOwner(ownerId: string): void;
	/** Dispose all sessions (shutdown). */
	disposeAll(): void;
	/** Number of live sessions currently mounted (diagnostics / tests). */
	size(): number;
}

/** Create an isolated live-session registry (one per app / per relay instance). */
export function createLiveRegistry(): LiveRegistry {
	const defs = new Map<string, () => LiveComponentDefinition>();
	const sessions = new Map<string, LiveSessionHandle>();
	const byOwner = new Map<string, Set<string>>();

	const dispose = (id: string): void => {
		const handle = sessions.get(id);
		if (!handle) return;
		handle.session.dispose();
		sessions.delete(id);
		const owned = byOwner.get(handle.ownerId);
		if (owned) {
			owned.delete(id);
			if (owned.size === 0) byOwner.delete(handle.ownerId);
		}
	};

	return {
		define(name, factory) {
			defs.set(name, factory);
		},
		has(name) {
			return defs.has(name);
		},
		mount(name, ownerId) {
			const factory = defs.get(name);
			if (!factory) {
				throw new Error(
					`[aurora:live] unknown live component "${name}" — register it with registry.define("${name}", …) before mounting.`,
				);
			}
			const id = crypto.randomUUID();
			const handle: LiveSessionHandle = {
				id,
				ownerId,
				session: mountLiveSession(factory),
			};
			sessions.set(id, handle);
			const owned = byOwner.get(ownerId) ?? new Set<string>();
			owned.add(id);
			byOwner.set(ownerId, owned);
			return handle;
		},
		get(id) {
			return sessions.get(id)?.session;
		},
		dispose,
		disposeOwner(ownerId) {
			const owned = byOwner.get(ownerId);
			if (!owned) return;
			// Copy ids first — `dispose` mutates the same set as it goes.
			for (const id of [...owned]) dispose(id);
			byOwner.delete(ownerId);
		},
		disposeAll() {
			for (const id of [...sessions.keys()]) dispose(id);
		},
		size() {
			return sessions.size;
		},
	};
}
