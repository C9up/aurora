/**
 * Browser DX helpers — navigation + a typed `localStorage` wrapper.
 *
 * All are SSR-safe: on the server (no `window` / `localStorage`) navigation is
 * a no-op and storage reads return `null`, so the same code runs during SSR
 * without `typeof window` guards at every call site. Node-free — part of the
 * client barrel.
 */

import { effect, type Signal, signal } from "./reactive.js";

/** Navigate to `url` with a full page load. No-op during SSR. */
export function redirect(url: string): void {
	if (typeof window !== "undefined") {
		window.location.href = url;
	}
}

/**
 * Navigate to `url`, replacing the current history entry (no back-button trap —
 * use after a login/logout so "back" doesn't return to the form). No-op on SSR.
 */
export function replace(url: string): void {
	if (typeof window !== "undefined") {
		window.location.replace(url);
	}
}

/** Reload the current page. No-op during SSR. */
export function reload(): void {
	if (typeof window !== "undefined") {
		window.location.reload();
	}
}

/** Which Web Storage area backs a {@link WebStorage}. */
export type StorageArea = "local" | "session";

export interface WebStorageOptions {
	/**
	 * Key namespace, e.g. `"myapp:"`. Keys are written and read prefixed so
	 * independent stores never collide. Default `""` (no namespace).
	 */
	prefix?: string;
	/**
	 * Backing area — `"local"` (`localStorage`, persists across sessions, the
	 * default) or `"session"` (`sessionStorage`, cleared when the tab closes).
	 */
	area?: StorageArea;
}

/**
 * Typed, SSR-safe key/value store over `localStorage` / `sessionStorage`.
 *
 * - Values are JSON-serialised; reads return `null` on the server, on a missing
 *   key, or on malformed JSON.
 * - Writes swallow quota / private-mode errors so a full store never crashes
 *   the app (best-effort).
 * - `prefix` namespaces keys; {@link keys} and {@link clear} stay scoped to it,
 *   so two prefixed stores over the same area never touch each other's data.
 */
export class WebStorage {
	readonly #prefix: string;
	readonly #area: StorageArea;

	constructor(options: WebStorageOptions = {}) {
		this.#prefix = options.prefix ?? "";
		this.#area = options.area ?? "local";
	}

	#backend(): Storage | undefined {
		if (typeof window === "undefined") return undefined;
		return this.#area === "session"
			? window.sessionStorage
			: window.localStorage;
	}

	/** The on-disk key for `key`, namespaced by the configured prefix. */
	fullKey(key: string): string {
		return this.#prefix + key;
	}

	get<T>(key: string): T | null {
		const backend = this.#backend();
		if (!backend) return null;
		const raw = backend.getItem(this.fullKey(key));
		if (raw === null) return null;
		try {
			return JSON.parse(raw) as T;
		} catch {
			return null;
		}
	}

	set(key: string, value: unknown): void {
		const backend = this.#backend();
		if (!backend) return;
		try {
			backend.setItem(this.fullKey(key), JSON.stringify(value));
		} catch {
			// QuotaExceededError / Safari private mode — best-effort write.
		}
	}

	/** Whether `key` is present (and not the server). */
	has(key: string): boolean {
		const backend = this.#backend();
		if (!backend) return false;
		return backend.getItem(this.fullKey(key)) !== null;
	}

	remove(key: string): void {
		this.#backend()?.removeItem(this.fullKey(key));
	}

	/** Read `key`, or compute + persist `factory()` on a miss, returning the value. */
	getOrSet<T>(key: string, factory: () => T): T {
		const existing = this.get<T>(key);
		if (existing !== null) return existing;
		const value = factory();
		this.set(key, value);
		return value;
	}

	/** Keys in this store, prefix stripped. Empty array during SSR. */
	keys(): string[] {
		const backend = this.#backend();
		if (!backend) return [];
		const out: string[] = [];
		for (let i = 0; i < backend.length; i++) {
			const k = backend.key(i);
			if (k === null) continue;
			if (this.#prefix === "" || k.startsWith(this.#prefix)) {
				out.push(k.slice(this.#prefix.length));
			}
		}
		return out;
	}

	/** Remove this store's keys. With no prefix this clears the whole area. */
	clear(): void {
		const backend = this.#backend();
		if (!backend) return;
		if (this.#prefix === "") {
			backend.clear();
			return;
		}
		for (const key of this.keys()) backend.removeItem(this.fullKey(key));
	}
}

/**
 * Default `localStorage` store (no namespace). Backward-compatible with the
 * previous `storage.get/set/remove/clear` helper, plus `has`/`keys`/`getOrSet`.
 */
export const storage = new WebStorage();

/** Default `sessionStorage` store (no namespace) — cleared when the tab closes. */
export const session = new WebStorage({ area: "session" });

export interface PersistedSignalOptions extends WebStorageOptions {
	/**
	 * Update the signal when ANOTHER tab writes the same key (the browser
	 * `storage` event). Default `true`. Only effective for `area: "local"` —
	 * the browser never emits storage events for `sessionStorage` across tabs.
	 */
	crossTab?: boolean;
}

/**
 * A {@link Signal} whose value is mirrored to web storage.
 *
 * The initial value is read from storage (falling back to `initial` on a miss)
 * and every write is persisted via a reactive `effect`. With `crossTab`
 * (default `true`, local area only) the signal also updates live when another
 * tab writes the same key. SSR-safe: with no `window` it is a plain in-memory
 * signal seeded with `initial`. Because the mirror runs inside `effect`, a
 * `persistedSignal` created in a component's setup is disposed with it.
 */
export function persistedSignal<T>(
	key: string,
	initial: T,
	options: PersistedSignalOptions = {},
): Signal<T> {
	const store = new WebStorage(options);
	const stored = store.get<T>(key);
	const sig = signal<T>(stored !== null ? stored : initial);

	// Mirror every change back to storage; runs once immediately, then on change.
	effect(() => {
		store.set(key, sig());
	});

	if (
		(options.crossTab ?? true) &&
		(options.area ?? "local") === "local" &&
		typeof window !== "undefined"
	) {
		const fullKey = store.fullKey(key);
		window.addEventListener("storage", (event) => {
			if (event.key !== fullKey || event.newValue === null) return;
			try {
				sig(JSON.parse(event.newValue) as T);
			} catch {
				// Ignore a malformed cross-tab write.
			}
		});
	}

	return sig;
}

// ─── Reactive browser-state signals ──────────────────────────────────
//
// Each returns a Signal seeded from the current browser state and refreshed
// when the relevant event fires. The listener lives for the page lifetime, so
// create these ONCE at module scope and share the signal rather than calling
// them per component render. SSR-safe: with no `window`/`document`/`navigator`
// they return a plain signal seeded with a sensible default and never listen.

/**
 * Internal: a signal seeded by `read()` and refreshed when any of `events`
 * fire on `target`. `target` is `undefined` during SSR — then it's a static
 * signal of the default `read()`.
 */
function eventSignal<T>(
	target: EventTarget | undefined,
	events: string[],
	read: () => T,
): Signal<T> {
	const sig = signal<T>(read());
	if (target) {
		const update = (): void => {
			sig(read());
		};
		for (const ev of events) target.addEventListener(ev, update);
	}
	return sig;
}

/** Reactive `window.matchMedia(query).matches`. `false` during SSR. */
export function mediaQuery(query: string): Signal<boolean> {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return signal(false);
	}
	const mql = window.matchMedia(query);
	const sig = signal(mql.matches);
	mql.addEventListener("change", (event) => {
		sig(event.matches);
	});
	return sig;
}

/** Reactive `prefers-color-scheme: dark`. Shortcut over {@link mediaQuery}. */
export function prefersDark(): Signal<boolean> {
	return mediaQuery("(prefers-color-scheme: dark)");
}

/** Reactive online/offline status (`navigator.onLine`). `true` during SSR. */
export function online(): Signal<boolean> {
	const read = (): boolean =>
		typeof navigator === "undefined" ? true : navigator.onLine;
	return eventSignal(
		typeof window === "undefined" ? undefined : window,
		["online", "offline"],
		read,
	);
}

export interface WindowSize {
	width: number;
	height: number;
}

/** Reactive `{ width, height }` of the viewport. `{0,0}` during SSR. */
export function windowSize(): Signal<WindowSize> {
	const read = (): WindowSize =>
		typeof window === "undefined"
			? { width: 0, height: 0 }
			: { width: window.innerWidth, height: window.innerHeight };
	return eventSignal(
		typeof window === "undefined" ? undefined : window,
		["resize"],
		read,
	);
}

/** Reactive tab visibility (`!document.hidden`). `true` during SSR. */
export function visibility(): Signal<boolean> {
	const read = (): boolean =>
		typeof document === "undefined" ? true : !document.hidden;
	return eventSignal(
		typeof document === "undefined" ? undefined : document,
		["visibilitychange"],
		read,
	);
}

/** Reactive `window.location.hash`. `""` during SSR. */
export function hash(): Signal<string> {
	const read = (): string =>
		typeof window === "undefined" ? "" : window.location.hash;
	return eventSignal(
		typeof window === "undefined" ? undefined : window,
		["hashchange"],
		read,
	);
}

// ─── URL / history (SPA navigation) ──────────────────────────────────

/** Go back one history entry. No-op during SSR. */
export function back(): void {
	if (typeof window !== "undefined") window.history.back();
}

/** Go forward one history entry. No-op during SSR. */
export function forward(): void {
	if (typeof window !== "undefined") window.history.forward();
}

/**
 * SPA navigation: push `url` onto history WITHOUT a full page reload (contrast
 * {@link redirect}, which reloads). Emits a `popstate` event so reactive URL
 * consumers — e.g. {@link queryParam} or a router — pick up the change. No-op
 * during SSR.
 */
export function navigate(url: string): void {
	if (typeof window === "undefined") return;
	window.history.pushState({}, "", url);
	window.dispatchEvent(new Event("popstate"));
}

/**
 * A {@link Signal} bound to a single URL query parameter. Reading reflects the
 * current value (`null` when absent); writing updates the URL via `pushState`
 * (no reload). Stays in sync with back/forward and {@link navigate} through the
 * `popstate` event. SSR-safe: a plain `null` signal with no listeners.
 */
export function queryParam(key: string): Signal<string | null> {
	const read = (): string | null =>
		typeof window === "undefined"
			? null
			: new URLSearchParams(window.location.search).get(key);
	const sig = signal<string | null>(read());
	if (typeof window !== "undefined") {
		window.addEventListener("popstate", () => {
			sig(read());
		});
		// Mirror writes back to the URL (skips the no-op initial run).
		effect(() => {
			const value = sig();
			const url = new URL(window.location.href);
			if (value === null) url.searchParams.delete(key);
			else url.searchParams.set(key, value);
			const next = url.pathname + url.search + url.hash;
			const current =
				window.location.pathname +
				window.location.search +
				window.location.hash;
			if (next !== current) window.history.pushState({}, "", next);
		});
	}
	return sig;
}

// ─── Cookies ─────────────────────────────────────────────────────────

export interface CookieOptions {
	/** Path scope. Default `"/"`. */
	path?: string;
	/** Lifetime in seconds. */
	maxAge?: number;
	/** Absolute expiry. */
	expires?: Date;
	/** Domain scope. */
	domain?: string;
	/** SameSite policy. */
	sameSite?: "strict" | "lax" | "none";
	/** Restrict to HTTPS. */
	secure?: boolean;
}

/**
 * SSR seed of the request's cookies — a `name → value` map installed by
 * `renderPage` (server-side) before a page renders, so {@link cookie.get} and
 * {@link cookieSignal} can read the SAME values during SSR that the browser
 * will read from `document.cookie` after hydration. Without it the server has
 * no view of the request cookies and renders default UI state → a flash /
 * mismatch on hydration (the classic collapsed-sidebar flicker).
 *
 * Module-global by necessity (the page factory reads it ambiently). It is set
 * synchronously immediately before the synchronous render, so read your cookie
 * signals at the TOP of a page (before any `await`) to avoid a cross-request
 * race under concurrent async page factories. In the browser it is unused —
 * {@link cookie.get} reads `document.cookie` directly there.
 */
let cookieSeed: Record<string, string> = {};

/**
 * Install the SSR cookie seed (`name → value`). Called by `renderPage` from its
 * `cookies` allowlist; the hydrate bootstrap does NOT call it (the browser reads
 * `document.cookie`). Replaces any previous seed.
 */
export function setCookieStore(values: Record<string, string>): void {
	cookieSeed = { ...values };
}

/** The currently-installed SSR cookie seed (mainly for tests/introspection). */
export function getCookieStore(): Record<string, string> {
	return { ...cookieSeed };
}

/**
 * SSR-safe cookie accessor — the one store {@link WebStorage} can't cover, for
 * values the server also reads. In the browser reads/writes hit
 * `document.cookie`; during SSR reads come from the {@link setCookieStore} seed
 * and writes are a no-op. Names and values are URL-encoded.
 */
export const cookie = {
	get(name: string): string | null {
		if (typeof document === "undefined") return cookieSeed[name] ?? null;
		const prefix = `${encodeURIComponent(name)}=`;
		for (const part of document.cookie.split("; ")) {
			if (part.startsWith(prefix)) {
				return decodeURIComponent(part.slice(prefix.length));
			}
		}
		return null;
	},
	set(name: string, value: string, options: CookieOptions = {}): void {
		if (typeof document === "undefined") return;
		const parts = [
			`${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
			`path=${options.path ?? "/"}`,
		];
		if (options.maxAge !== undefined) parts.push(`max-age=${options.maxAge}`);
		if (options.expires) parts.push(`expires=${options.expires.toUTCString()}`);
		if (options.domain) parts.push(`domain=${options.domain}`);
		if (options.sameSite) parts.push(`samesite=${options.sameSite}`);
		if (options.secure) parts.push("secure");
		// biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is async-only and unsupported in Safari/Firefox; `document.cookie` is the sole sync, broadly-supported write path for an SSR-safe helper.
		document.cookie = parts.join("; ");
	},
	remove(
		name: string,
		options: Pick<CookieOptions, "path" | "domain"> = {},
	): void {
		this.set(name, "", { ...options, maxAge: 0, expires: new Date(0) });
	},
};

/**
 * Maps a typed value to and from the string a cookie stores. Pass one to
 * {@link cookieState} for non-string state (booleans, enums, JSON).
 */
export interface CookieCodec<T> {
	/** Parse the raw cookie string into `T`. */
	parse(raw: string): T;
	/** Serialize `T` into the raw cookie string. */
	serialize(value: T): string;
}

/** Codec for a boolean cookie, stored as `"1"` / `"0"`. */
export const booleanCookie: CookieCodec<boolean> = {
	parse: (raw) => raw === "1" || raw === "true",
	serialize: (value) => (value ? "1" : "0"),
};

/**
 * Codec for a JSON-serializable value. A parse failure (malformed cookie) is
 * surfaced by returning `fallback`, so a tampered cookie never throws mid-render.
 */
export function jsonCookie<T>(fallback: T): CookieCodec<T> {
	return {
		parse: (raw) => {
			try {
				return JSON.parse(raw);
			} catch {
				return fallback;
			}
		},
		serialize: (value) => JSON.stringify(value),
	};
}

/**
 * A {@link Signal} backed by a cookie — the isomorphic counterpart to
 * {@link persistedSignal}. It is seeded from the cookie (the
 * {@link setCookieStore} request seed during SSR, `document.cookie` in the
 * browser) and persists every change back to the cookie via a reactive
 * `effect`. Because the same seed is visible on both sides, a page renders the
 * SAME markup server- and client-side — no hydration mismatch, no flash of the
 * default state (e.g. a sidebar that animates open→collapsed on every load).
 *
 * Use {@link cookieSignal} for string state; pass a {@link CookieCodec} here for
 * booleans/enums/JSON (e.g. {@link booleanCookie}). Created inside a component's
 * setup, the persistence effect is disposed with it.
 *
 * Read it at the TOP of a page (before any `await`) so the SSR seed is current —
 * see {@link setCookieStore}.
 */
export function cookieState<T>(
	name: string,
	initial: T,
	codec: CookieCodec<T>,
	options: CookieOptions = {},
): Signal<T> {
	const raw = cookie.get(name);
	const sig = signal<T>(raw === null ? initial : codec.parse(raw));

	// Mirror every change back to the cookie. Runs once immediately (a no-op
	// write during SSR, where `cookie.set` bails) then on each change.
	effect(() => {
		cookie.set(name, codec.serialize(sig()), options);
	});

	return sig;
}

const stringCookie: CookieCodec<string> = {
	parse: (raw) => raw,
	serialize: (value) => value,
};

/**
 * A {@link Signal} backed by a string cookie — {@link cookieState} with an
 * identity codec, for the common case where the value is already a string.
 */
export function cookieSignal(
	name: string,
	initial: string,
	options: CookieOptions = {},
): Signal<string> {
	return cookieState(name, initial, stringCookie, options);
}

// ─── Clipboard & Web Share ───────────────────────────────────────────

/** Async clipboard access. Methods return `false`/`null` when unavailable. */
export const clipboard = {
	/** Copy `text`. Returns whether it succeeded. */
	async copy(text: string): Promise<boolean> {
		if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
			return false;
		}
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			return false;
		}
	},
	/** Read clipboard text, or `null` if unavailable / denied. */
	async read(): Promise<string | null> {
		if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
			return null;
		}
		try {
			return await navigator.clipboard.readText();
		} catch {
			return null;
		}
	},
};

export interface ShareData {
	title?: string;
	text?: string;
	url?: string;
}

/**
 * Invoke the native Web Share sheet. Returns `false` when unsupported or the
 * user cancels — never throws.
 */
export async function share(data: ShareData): Promise<boolean> {
	if (
		typeof navigator === "undefined" ||
		typeof navigator.share !== "function"
	) {
		return false;
	}
	try {
		await navigator.share(data);
		return true;
	} catch {
		return false;
	}
}
