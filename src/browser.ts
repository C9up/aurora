/**
 * Browser DX helpers — navigation + a typed `localStorage` wrapper.
 *
 * All are SSR-safe: on the server (no `window` / `localStorage`) navigation is
 * a no-op and storage reads return `null`, so the same code runs during SSR
 * without `typeof window` guards at every call site. Node-free — part of the
 * client barrel.
 */

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

/**
 * Typed, SSR-safe `localStorage` wrapper. Values are JSON-serialised; reads
 * return `null` on the server, on a missing key, or on malformed JSON. Writes
 * swallow quota / private-mode errors so a full storage never crashes the app.
 */
export const storage = {
	get<T>(key: string): T | null {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem(key);
		if (raw === null) return null;
		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	},
	set(key: string, value: unknown): void {
		if (typeof localStorage === "undefined") return;
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {
			// QuotaExceededError / Safari private mode — best-effort write.
		}
	},
	remove(key: string): void {
		if (typeof localStorage !== "undefined") {
			localStorage.removeItem(key);
		}
	},
	clear(): void {
		if (typeof localStorage !== "undefined") {
			localStorage.clear();
		}
	},
};
