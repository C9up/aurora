/**
 * Browser-side relay helper — hides the EventSource + POST handshake
 * Ream's `@c9up/relay` package expects.
 *
 *   import { relay } from '@c9up/aurora/relay'
 *
 *   relay().subscribe(`project/${id}`, (ev) => {
 *     console.log('received', ev)
 *   })
 *
 * One EventSource per page (a singleton inside this module). All
 * subscribe calls fan out to its uid. The connection re-opens after
 * the browser auto-reconnect; subscriptions are re-applied.
 *
 * This module is browser-only. It's shipped via aurora's pre-built
 * `dist/` and imported through the same importmap that maps
 * `@c9up/aurora`. Node-side code that pulls it will trip on
 * `EventSource` being undefined.
 */

/**
 * Connection lifecycle status. Mirrors `@adonisjs/transmit-client`'s
 * `TransmitStatus` (minus `initializing`, which the singleton never
 * exposes — the first `relay()` call opens straight into `connecting`).
 */
export type RelayStatus =
	| "connecting"
	| "connected"
	| "disconnected"
	| "reconnecting";

export interface RelayClient {
	subscribe<E>(channel: string, handler: (event: E) => void): () => void;
	/**
	 * Register a connection-status listener. Returns a detacher. Mirrors
	 * `transmit.on('connected' | 'disconnected' | ...)`.
	 */
	on(status: RelayStatus, callback: (status: RelayStatus) => void): () => void;
	close(): void;
}

interface RelayState {
	sse: EventSource | null;
	uid: string | null;
	channels: Map<string, Set<(event: unknown) => void>>;
	/** Channels we've already wired an SSE listener for on the current sse. */
	attached: Set<string>;
	/** Current connection status. */
	status: RelayStatus;
	/** Status listeners, keyed by the status they fire on. */
	statusListeners: Map<RelayStatus, Set<(status: RelayStatus) => void>>;
	/** Consecutive failed-connection count, reset on every `connected` frame. */
	reconnectAttempts: number;
}

const STATE: RelayState = {
	sse: null,
	uid: null,
	channels: new Map(),
	attached: new Set(),
	status: "connecting",
	statusListeners: new Map(),
	reconnectAttempts: 0,
};

export interface RelayOptions {
	/** SSE endpoint. Defaults to `/__relay/events`. */
	sseUrl?: string;
	/** Subscribe POST endpoint. Defaults to `/__relay/subscribe`. */
	subscribeUrl?: string;
	/** Unsubscribe POST endpoint. Defaults to `/__relay/unsubscribe`. */
	unsubscribeUrl?: string;
	/** Optional bearer token (for guarded relay routes). */
	bearer?: string;
	/**
	 * Give up after this many consecutive reconnect attempts. Default 5
	 * (Transmit parity). `0` disables the cap — the browser's native
	 * EventSource keeps retrying forever.
	 */
	maxReconnectAttempts?: number;
	/** Fired before each reconnect attempt with the 1-based attempt count. */
	onReconnectAttempt?: (attempt: number) => void;
	/** Fired once when `maxReconnectAttempts` is exhausted and we give up. */
	onReconnectFailed?: () => void;
}

interface RelayConfigResolved {
	sseUrl: string;
	subscribeUrl: string;
	unsubscribeUrl: string;
	bearer: string;
	maxReconnectAttempts: number;
	onReconnectAttempt?: (attempt: number) => void;
	onReconnectFailed?: () => void;
}

let CONFIG: RelayConfigResolved = {
	sseUrl: "/__relay/events",
	subscribeUrl: "/__relay/subscribe",
	unsubscribeUrl: "/__relay/unsubscribe",
	bearer: "",
	maxReconnectAttempts: 5,
};

/**
 * Configure the relay endpoints + bearer + reconnect policy. Call once
 * at boot if you need to override the defaults. Multiple calls overwrite
 * — last call wins.
 */
export function configureRelay(options: RelayOptions): void {
	CONFIG = {
		sseUrl: options.sseUrl ?? CONFIG.sseUrl,
		subscribeUrl: options.subscribeUrl ?? CONFIG.subscribeUrl,
		unsubscribeUrl: options.unsubscribeUrl ?? CONFIG.unsubscribeUrl,
		bearer: options.bearer ?? CONFIG.bearer,
		maxReconnectAttempts:
			options.maxReconnectAttempts ?? CONFIG.maxReconnectAttempts,
		onReconnectAttempt: options.onReconnectAttempt ?? CONFIG.onReconnectAttempt,
		onReconnectFailed: options.onReconnectFailed ?? CONFIG.onReconnectFailed,
	};
}

/**
 * Lazily-opened EventSource bound to a single page lifetime. Returns
 * the same client across calls — duplicate `relay()` calls share the
 * underlying connection.
 */
export function relay(): RelayClient {
	if (!STATE.sse) {
		open();
	}
	return CLIENT;
}

const CLIENT: RelayClient = {
	subscribe(channel, handler) {
		let handlers = STATE.channels.get(channel);
		if (!handlers) {
			handlers = new Set();
			STATE.channels.set(channel, handlers);
		}
		const adapted = handler as (event: unknown) => void;
		handlers.add(adapted);

		// Wire the SSE listener for this channel's NAMED events — the relay
		// broadcasts `event: <channel>`, so a per-channel addEventListener (not
		// the default `onmessage`) is what actually receives the payload.
		if (STATE.sse) attachChannel(STATE.sse, channel);

		// Subscribe over POST as soon as we have a uid. Before the first uid (or
		// during an auto-reconnect) the channel already lives in STATE.channels
		// and is (re-)subscribed by the `connected` handler — so the server,
		// which assigns a fresh uid per connection, always learns every channel.
		if (STATE.uid) {
			postSubscribe(channel).catch((err: unknown) => {
				console.warn(`[aurora/relay] subscribe to ${channel} failed:`, err);
			});
		}

		// Detacher — removes the local listener. When it was the LAST handler
		// on the channel, the server-side subscription is dropped too (POST
		// /__relay/unsubscribe), so the server stops streaming a channel
		// nobody's listening to. Other channels / other listeners are
		// untouched.
		return () => {
			handlers?.delete(adapted);
			if (handlers && handlers.size === 0) {
				STATE.channels.delete(channel);
				if (STATE.uid) {
					postUnsubscribe(channel).catch((err: unknown) => {
						console.warn(
							`[aurora/relay] unsubscribe from ${channel} failed:`,
							err,
						);
					});
				}
			}
		};
	},

	on(status, callback) {
		let set = STATE.statusListeners.get(status);
		if (!set) {
			set = new Set();
			STATE.statusListeners.set(status, set);
		}
		set.add(callback);
		return () => {
			set?.delete(callback);
		};
	},

	close() {
		if (STATE.sse) {
			STATE.sse.close();
			STATE.sse = null;
		}
		STATE.uid = null;
		STATE.channels.clear();
		STATE.attached.clear();
		STATE.reconnectAttempts = 0;
	},
};

function open(): void {
	const sse = new EventSource(CONFIG.sseUrl);
	STATE.sse = sse;
	STATE.attached = new Set();
	changeStatus("connecting");

	sse.addEventListener("connected", (ev) => {
		const data = safeJson<{ uid?: string }>(messageData(ev));
		if (data && typeof data.uid === "string") {
			STATE.uid = data.uid;
			// A successful (re)connect clears the failure counter and flips the
			// status back to `connected`.
			STATE.reconnectAttempts = 0;
			changeStatus("connected");
			// Re-apply EVERY active subscription on each (re)connect. The server
			// assigns a fresh uid per connection and has no memory of prior
			// subscriptions, so both the first connect AND browser auto-reconnects
			// must re-POST every live channel — otherwise the client silently
			// stops receiving after a reconnect.
			for (const channel of STATE.channels.keys()) {
				postSubscribe(channel).catch((err: unknown) => {
					console.warn(
						`[aurora/relay] re-subscribe to ${channel} failed:`,
						err,
					);
				});
			}
		}
	});

	// The native EventSource auto-reconnects on a dropped connection, firing
	// `error` each time. Mirror Transmit's reconnect bookkeeping: surface a
	// `disconnected` → `reconnecting` transition, count attempts, and once the
	// cap is reached close the stream (stopping the native retry loop) and fire
	// `onReconnectFailed`.
	sse.addEventListener("error", () => {
		if (STATE.status !== "reconnecting") changeStatus("disconnected");
		changeStatus("reconnecting");
		CONFIG.onReconnectAttempt?.(STATE.reconnectAttempts + 1);
		if (
			CONFIG.maxReconnectAttempts > 0 &&
			STATE.reconnectAttempts >= CONFIG.maxReconnectAttempts
		) {
			sse.close();
			if (STATE.sse === sse) STATE.sse = null;
			CONFIG.onReconnectFailed?.();
			return;
		}
		STATE.reconnectAttempts++;
	});

	// Re-attach channel listeners — a close()+reopen builds a fresh EventSource
	// that has lost the listeners wired by earlier subscribe() calls.
	for (const channel of STATE.channels.keys()) attachChannel(sse, channel);
}

/** Update the status and notify every listener registered for it. */
function changeStatus(status: RelayStatus): void {
	STATE.status = status;
	const set = STATE.statusListeners.get(status);
	if (!set) return;
	for (const cb of set) {
		try {
			cb(status);
		} catch (err) {
			console.warn(`[aurora/relay] status listener for ${status} threw:`, err);
		}
	}
}

/**
 * Wire one SSE listener for a channel's named broadcast events. The relay sends
 * `event: <channel>\ndata: <JSON payload>`, so each channel is its own named
 * event — `onmessage` (default/unnamed only) never sees them. The handler
 * receives the broadcast payload verbatim (the value passed to
 * `relay.broadcast(channel, payload)`).
 */
function attachChannel(sse: EventSource, channel: string): void {
	if (STATE.attached.has(channel)) return;
	STATE.attached.add(channel);
	sse.addEventListener(channel, (ev) => {
		const payload = safeJson<unknown>(messageData(ev));
		if (payload === null) return;
		const handlers = STATE.channels.get(channel);
		if (!handlers) return;
		for (const handler of handlers) {
			try {
				handler(payload);
			} catch (err) {
				console.warn(`[aurora/relay] listener for ${channel} threw:`, err);
			}
		}
	});
}

/** Read an SSE event's string `data` without an unsafe DOM cast. */
function messageData(ev: Event): string | null {
	if ("data" in ev && typeof ev.data === "string") return ev.data;
	return null;
}

function postSubscribe(channel: string): Promise<void> {
	return postHandshake(CONFIG.subscribeUrl, channel);
}

function postUnsubscribe(channel: string): Promise<void> {
	return postHandshake(CONFIG.unsubscribeUrl, channel);
}

/**
 * POST a `{ uid, channel }` handshake to a relay endpoint. Sends the
 * signed-CSRF trio blackhole expects: the `XSRF-TOKEN` cookie echoed as
 * the `X-XSRF-TOKEN` header plus `credentials: 'include'` so the cookie
 * itself rides along. Without both, the POST is rejected by the signed
 * double-submit guard. Mirrors `HttpClient.#retrieveXsrfToken` /
 * `createRequest` in `@adonisjs/transmit-client`.
 */
async function postHandshake(url: string, channel: string): Promise<void> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (CONFIG.bearer) headers.authorization = `Bearer ${CONFIG.bearer}`;
	const xsrf = retrieveXsrfToken();
	if (xsrf !== null) headers["x-xsrf-token"] = xsrf;
	const res = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify({ uid: STATE.uid, channel }),
		credentials: "include",
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}`);
	}
}

/**
 * Read the `XSRF-TOKEN` cookie so it can be echoed as the `X-XSRF-TOKEN`
 * header (signed double-submit CSRF). Browser-only — returns `null` under
 * SSR / any environment without `document`.
 */
function retrieveXsrfToken(): string | null {
	if (typeof document === "undefined") return null;
	const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
	if (!match) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		// A malformed cookie must not break subscribe/unsubscribe handshakes. The
		// server will reject an invalid token normally; the client should not throw
		// before it even sends the request.
		return match[1];
	}
}

function safeJson<T>(raw: unknown): T | null {
	if (typeof raw !== "string") return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}
