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
	E_AURORA_INVALID_LIVE_LIMIT,
	E_AURORA_LIVE_SESSION_LIMIT,
	E_AURORA_UNKNOWN_LIVE_COMPONENT,
} from "./errors.js";

import {
	type LiveComponentDefinition,
	type LiveSession,
	mountLiveSession,
} from "./liveSession.js";

/** A mounted instance: its id, the owner (e.g. relay uid), and the session. */
export interface LiveSessionHandle {
	id: string;
	ownerId: string;
	session: LiveSession;
}

/**
 * The bounds a registry keeps its sessions within.
 *
 * `mount` runs while a page renders, before the client has opened anything, so
 * a client that never comes back — curl, a crawler, a tab closed early — never
 * reaches the disconnect that used to be the only way out. Without these, a GET
 * loop on a page with a live component grew the heap until the process died.
 */
export interface LiveRegistryOptions {
	/**
	 * How long a mounted session waits to be claimed — by its owner subscribing
	 * to its channel or sending it an event — before it is disposed. Default one
	 * minute.
	 */
	claimTimeoutMs?: number;
	/**
	 * How long a claimed session may go without an event, a subscription or a
	 * keep-alive before it is disposed. Default ten minutes; `liveClient` sends a
	 * keep-alive every two, so a client that only watches stays. Keep it above
	 * the client's `keepAliveMs`.
	 *
	 * It used to be off by default, which kept every session a client had
	 * claimed once until the process ended: with the global cap, a few thousand
	 * visitors — or one attacker with two requests per slot — locked every later
	 * mount out until a restart.
	 */
	idleTimeoutMs?: number;
	/**
	 * Sessions one owner may hold. Mounting past it disposes that owner's oldest
	 * session — it only ever costs the owner. Default 32.
	 */
	maxPerOwner?: number;
	/**
	 * Sessions the registry holds in all. Default 10 000. Mounting past it makes
	 * room first: the oldest session nobody claimed goes, else the least recently
	 * used one that has been silent for half the idle timeout. Only when every
	 * session is in use does `mount` throw `E_AURORA_LIVE_SESSION_LIMIT` (answer
	 * 503).
	 */
	maxSessions?: number;
}

export interface LiveRegistry {
	/** Register a live component definition under `name` (the "live class"). */
	define(name: string, factory: () => LiveComponentDefinition): void;
	/** True if `name` is registered. */
	has(name: string): boolean;
	/**
	 * Mount a fresh session of `name` owned by `ownerId`. Each call gets its own
	 * per-session signals. Throws if `name` is unknown — an unmountable component
	 * must fail loudly, never silently serve nothing — and
	 * `E_AURORA_LIVE_SESSION_LIMIT` when the registry is full.
	 */
	mount(name: string, ownerId: string): LiveSessionHandle;
	/**
	 * Mark a session as in use by its client, which keeps it past the claim
	 * timeout and restarts its idle clock. Returns false for an unknown id.
	 */
	claim(id: string): boolean;
	/**
	 * Restart a claimed session's idle clock — what a keep-alive does. Claims
	 * nothing: returns false for an unknown or unclaimed id.
	 */
	touch(id: string): boolean;
	/** Look up a live session by instance id. */
	get(id: string): LiveSession | undefined;
	/** The owner a session was mounted for, or undefined for an unknown id. */
	ownerOf(id: string): string | undefined;
	/** Dispose one session instance (frees its effects). */
	dispose(id: string): void;
	/** Dispose EVERY session a given owner opened — call on disconnect. */
	disposeOwner(ownerId: string): void;
	/** Dispose all sessions (shutdown). */
	disposeAll(): void;
	/** Number of live sessions currently mounted (diagnostics / tests). */
	size(): number;
}

/** A session and what the sweep needs to know about it. */
interface Entry extends LiveSessionHandle {
	claimed: boolean;
	/** When it was mounted, claimed, last sent an event or a keep-alive. */
	seenAt: number;
}

/** Ten minutes: five of `liveClient`'s keep-alives. */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

function limit(name: string, value: number | undefined, fallback: number) {
	const resolved = value ?? fallback;
	if (!(resolved > 0)) {
		throw new E_AURORA_INVALID_LIVE_LIMIT([name, String(value)]);
	}
	return resolved;
}

/** Create an isolated live-session registry (one per app / per relay instance). */
export function createLiveRegistry(
	options: LiveRegistryOptions = {},
): LiveRegistry {
	const claimTimeoutMs = limit(
		"claimTimeoutMs",
		options.claimTimeoutMs,
		60_000,
	);
	const idleTimeoutMs = limit(
		"idleTimeoutMs",
		options.idleTimeoutMs,
		DEFAULT_IDLE_TIMEOUT_MS,
	);
	// A claimed session seen this recently is in use, and a full registry does
	// not evict it to make room. Half the idle timeout: a client that keeps its
	// session alive is always inside it.
	const inUseMs = idleTimeoutMs / 2;
	const maxPerOwner = limit("maxPerOwner", options.maxPerOwner, 32);
	const maxSessions = limit("maxSessions", options.maxSessions, 10_000);
	// A quarter of the shortest timeout, so a session outlives its limit by at
	// most a quarter of it; never busier than four times a second.
	const sweepEveryMs = Math.min(
		Math.max(Math.min(claimTimeoutMs, idleTimeoutMs) / 4, 250),
		60_000,
	);
	const sweeps = Number.isFinite(Math.min(claimTimeoutMs, idleTimeoutMs));

	const defs = new Map<string, () => LiveComponentDefinition>();
	// In the order they were last seen: the first entry is the least recently
	// used. A Map keeps insertion order, so being seen is a delete and a set.
	const sessions = new Map<string, Entry>();
	// The sessions nobody claimed yet, oldest first.
	const unclaimed = new Set<string>();
	// A Set keeps insertion order, so an owner's first id is its oldest session.
	const byOwner = new Map<string, Set<string>>();
	let sweeper: ReturnType<typeof setInterval> | undefined;

	const stopSweeping = (): void => {
		if (sweeper === undefined) return;
		clearInterval(sweeper);
		sweeper = undefined;
	};

	const dispose = (id: string): void => {
		const handle = sessions.get(id);
		if (!handle) return;
		handle.session.dispose();
		sessions.delete(id);
		unclaimed.delete(id);
		const owned = byOwner.get(handle.ownerId);
		if (owned) {
			owned.delete(id);
			if (owned.size === 0) byOwner.delete(handle.ownerId);
		}
		if (sessions.size === 0) stopSweeping();
	};

	const sweep = (): void => {
		const now = Date.now();
		for (const [id, entry] of sessions) {
			const timeout = entry.claimed ? idleTimeoutMs : claimTimeoutMs;
			if (now - entry.seenAt >= timeout) dispose(id);
		}
	};

	/** The entry was just seen: it moves to the most recently used end. */
	const seen = (entry: Entry): void => {
		entry.seenAt = Date.now();
		sessions.delete(entry.id);
		sessions.set(entry.id, entry);
	};

	/**
	 * Free one slot in a full registry, or say there is none to free: the
	 * expired sessions go first, then the oldest unclaimed one, then the least
	 * recently used one that is no longer in use. Never a session in use — that
	 * would hand anyone who can mount a way to end somebody else's.
	 */
	const makeRoom = (): boolean => {
		sweep();
		if (sessions.size < maxSessions) return true;
		for (const oldest of unclaimed) {
			dispose(oldest);
			return true;
		}
		const now = Date.now();
		for (const [id, entry] of sessions) {
			// The least recently used: if it is in use, every session is.
			if (now - entry.seenAt < inUseMs) return false;
			dispose(id);
			return true;
		}
		return false;
	};

	const startSweeping = (): void => {
		if (sweeper !== undefined || !sweeps) return;
		sweeper = setInterval(sweep, sweepEveryMs);
		// Node's timer would otherwise keep a process alive that has nothing
		// left to do; a browser's has no such method.
		const unref: unknown = Reflect.get(Object(sweeper), "unref");
		if (typeof unref === "function") Reflect.apply(unref, sweeper, []);
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
				throw new E_AURORA_UNKNOWN_LIVE_COMPONENT([name, name]);
			}
			// Room is made before anything is built: an owner at its cap gives up
			// its oldest session, and a full registry refuses rather than evicting
			// a session somebody else is using.
			const owned = byOwner.get(ownerId);
			if (owned !== undefined && owned.size >= maxPerOwner) {
				for (const oldest of owned) {
					dispose(oldest);
					if (owned.size < maxPerOwner) break;
				}
			}
			if (sessions.size >= maxSessions && !makeRoom()) {
				throw new E_AURORA_LIVE_SESSION_LIMIT([sessions.size, name]);
			}
			const id = crypto.randomUUID();
			// The session id namespaces this component's ids, here and on the
			// client, which reads it back off the mount response.
			const entry: Entry = {
				id,
				ownerId,
				session: mountLiveSession(factory, id),
				claimed: false,
				seenAt: Date.now(),
			};
			sessions.set(id, entry);
			unclaimed.add(id);
			const ids = byOwner.get(ownerId) ?? new Set<string>();
			ids.add(id);
			byOwner.set(ownerId, ids);
			startSweeping();
			return { id, ownerId, session: entry.session };
		},
		claim(id) {
			const entry = sessions.get(id);
			if (entry === undefined) return false;
			entry.claimed = true;
			unclaimed.delete(id);
			seen(entry);
			return true;
		},
		touch(id) {
			const entry = sessions.get(id);
			if (entry === undefined || !entry.claimed) return false;
			seen(entry);
			return true;
		},
		get(id) {
			return sessions.get(id)?.session;
		},
		ownerOf(id) {
			return sessions.get(id)?.ownerId;
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
