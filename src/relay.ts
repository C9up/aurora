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
	pending: Array<() => void>;
}

const STATE: RelayState = {
	sse: null,
	uid: null,
	channels: new Map(),
	pending: [],
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

		// Subscribe over POST as soon as we have a uid. If the SSE is
		// still mid-handshake, queue the call and flush on `connected`.
		const doSubscribe = () => {
			postSubscribe(channel).catch((err: unknown) => {
				console.warn(`[aurora/relay] subscribe to ${channel} failed:`, err);
			});
		};
		if (STATE.uid) doSubscribe();
		else STATE.pending.push(doSubscribe);

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
		STATE.pending.length = 0;
	},
};

function open(): void {
	const sse = new EventSource(CONFIG.sseUrl);
	STATE.sse = sse;

	sse.addEventListener("connected", (ev) => {
		const data = safeJson<{ uid?: string }>((ev as MessageEvent).data);
		if (data && typeof data.uid === "string") {
			STATE.uid = data.uid;
			const queue = STATE.pending.splice(0);
			for (const fn of queue) fn();
		}
	});

	sse.onmessage = (ev) => {
		const data = safeJson<{ channel?: string; [key: string]: unknown }>(
			ev.data,
		);
		if (!data || typeof data.channel !== "string") return;
		const handlers = STATE.channels.get(data.channel);
		if (!handlers) return;
		for (const handler of handlers) {
			try {
				handler(data);
			} catch (err) {
				console.warn(`[aurora/relay] listener for ${data.channel} threw:`, err);
			}
		}
	};
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
