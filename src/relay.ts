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

export interface RelayClient {
	subscribe<E>(channel: string, handler: (event: E) => void): () => void;
	close(): void;
}

interface RelayState {
	sse: EventSource | null;
	uid: string | null;
	channels: Map<string, Set<(event: unknown) => void>>;
	/** Channels we've already wired an SSE listener for on the current sse. */
	attached: Set<string>;
}

const STATE: RelayState = {
	sse: null,
	uid: null,
	channels: new Map(),
	attached: new Set(),
};

export interface RelayOptions {
	/** SSE endpoint. Defaults to `/__relay/events`. */
	sseUrl?: string;
	/** Subscribe POST endpoint. Defaults to `/__relay/subscribe`. */
	subscribeUrl?: string;
	/** Optional bearer token (for guarded relay routes). */
	bearer?: string;
}

let CONFIG: Required<RelayOptions> = {
	sseUrl: "/__relay/events",
	subscribeUrl: "/__relay/subscribe",
	bearer: "",
};

/**
 * Configure the relay endpoints + bearer. Call once at boot if you
 * need to override the defaults. Multiple calls overwrite — last call
 * wins.
 */
export function configureRelay(options: RelayOptions): void {
	CONFIG = {
		sseUrl: options.sseUrl ?? CONFIG.sseUrl,
		subscribeUrl: options.subscribeUrl ?? CONFIG.subscribeUrl,
		bearer: options.bearer ?? CONFIG.bearer,
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

		// Detacher — only removes the local listener. The server-side
		// subscription stays open; closing it would interrupt other
		// listeners on the same channel.
		return () => {
			handlers?.delete(adapted);
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
	},
};

function open(): void {
	const sse = new EventSource(CONFIG.sseUrl);
	STATE.sse = sse;
	STATE.attached = new Set();

	sse.addEventListener("connected", (ev) => {
		const data = safeJson<{ uid?: string }>(messageData(ev));
		if (data && typeof data.uid === "string") {
			STATE.uid = data.uid;
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

	// Re-attach channel listeners — a close()+reopen builds a fresh EventSource
	// that has lost the listeners wired by earlier subscribe() calls.
	for (const channel of STATE.channels.keys()) attachChannel(sse, channel);
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

async function postSubscribe(channel: string): Promise<void> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (CONFIG.bearer) headers.authorization = `Bearer ${CONFIG.bearer}`;
	const res = await fetch(CONFIG.subscribeUrl, {
		method: "POST",
		headers,
		body: JSON.stringify({ uid: STATE.uid, channel }),
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}`);
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
