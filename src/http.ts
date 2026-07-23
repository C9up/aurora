/**
 * `HttpClient` — a small typed wrapper over `fetch` so call sites read
 * `await http.get<User>("/auth/me")` instead of hand-rolling headers,
 * `res.json()`, and status checks.
 *
 * - Auto JSON: a plain-object/array body is `JSON.stringify`-d with a
 *   `Content-Type: application/json` header; a JSON response is parsed.
 *   `FormData`/`Blob`/`URLSearchParams`/`string`/binary bodies pass through
 *   untouched.
 * - Bearer auth: a `token` (string or getter, read fresh per request) is sent
 *   as `Authorization: Bearer …` unless the caller set the header themselves.
 * - Errors: a non-2xx response rejects with an {@link HttpError} carrying the
 *   status, the `Response`, and the parsed body.
 *
 * Node-free and isomorphic — uses the global `fetch` (browsers, Node 18+,
 * Workers, Bun, Deno). Part of the client barrel.
 */

export interface HttpClientOptions {
	/** Prepended to every request URL, unless the URL is already absolute. */
	baseURL?: string;
	/** Headers merged into every request. */
	headers?: Record<string, string>;
	/**
	 * Bearer token sent as `Authorization: Bearer <token>`. A getter is read
	 * fresh on each request (so a rotated/late-set token is always current);
	 * a `null`/`undefined` result omits the header.
	 */
	token?: string | null | (() => string | null | undefined);
	/** Default `credentials` mode (e.g. `"include"` to send cookies). */
	credentials?: RequestCredentials;
	/**
	 * Allow default bearer/default Authorization headers to be sent to absolute
	 * cross-origin URLs. Default `false`: same-origin API clients should not leak
	 * credentials if an untrusted value becomes the request URL. Per-request
	 * `headers.Authorization` is still treated as explicit caller intent.
	 */
	allowCrossOriginAuth?: boolean;
	/**
	 * Default timeout in ms — the request is aborted (rejecting with a
	 * `TimeoutError`) if it doesn't settle in time. Combined with a per-request
	 * `signal`, whichever fires first wins.
	 */
	timeout?: number;
}

export interface HttpRequestOptions<T = unknown> {
	/** Query params appended to the URL. `null`/`undefined` values are skipped. */
	query?: Record<string, string | number | boolean | null | undefined>;
	/** Extra headers for this request (override the client defaults). */
	headers?: Record<string, string>;
	/** Per-request bearer token override (`null` to force-omit). */
	token?: string | null;
	/** Abort signal — abort it to cancel the request (e.g. on unmount / new keystroke). */
	signal?: AbortSignal;
	/** Per-request timeout in ms (overrides the client default). Aborts with a `TimeoutError`. */
	timeout?: number;
	/** `credentials` mode for this request. */
	credentials?: RequestCredentials;
	/**
	 * Per-request override for sending managed auth headers to cross-origin
	 * absolute URLs. Default inherits the client option (`false` by default).
	 */
	allowCrossOriginAuth?: boolean;
	/**
	 * Runtime validator/mapper for the parsed body. When provided, the return
	 * type is whatever it returns — no unchecked cast. When omitted, the parsed
	 * body is returned as `T` (an UNCHECKED assertion of the response shape).
	 */
	parse?: (raw: unknown) => T;
}

/** Thrown on a non-2xx response. Carries the status, the `Response`, and the parsed body. */
export class HttpError extends Error {
	readonly status: number;
	readonly response: Response;
	readonly data: unknown;

	constructor(response: Response, data: unknown) {
		super(`HTTP ${response.status} ${response.statusText} for ${response.url}`);
		this.name = "HttpError";
		this.status = response.status;
		this.response = response;
		this.data = data;
	}
}

/** Type guard for {@link HttpError} — clean `catch` narrowing without a cast. */
export function isHttpError(value: unknown): value is HttpError {
	return value instanceof HttpError;
}

/**
 * Whether `value` is an aborted/timed-out request error — an `AbortError`
 * (cancelled via a `signal`) or a `TimeoutError` (the `timeout` option fired).
 * Use it to silently ignore cancellations (e.g. a superseded search request).
 */
export function isAbortError(value: unknown): boolean {
	const name =
		value instanceof Error
			? value.name
			: typeof DOMException !== "undefined" && value instanceof DOMException
				? value.name
				: undefined;
	return name === "AbortError" || name === "TimeoutError";
}

/**
 * Outcome of a non-throwing request via {@link HttpClient.attempt}: a
 * discriminated union a form submit can branch on (`if (r.ok)`) instead of
 * wrapping every call in try/catch.
 */
export type HttpResult<T> =
	| { ok: true; data: T; error: null }
	| { ok: false; data: null; error: HttpError };

/** Whether `body` should be JSON-encoded (vs. passed to `fetch` untouched). */
function shouldJsonEncode(body: unknown): boolean {
	if (body === null || typeof body !== "object") {
		return typeof body !== "string";
	}
	if (
		body instanceof FormData ||
		body instanceof Blob ||
		body instanceof URLSearchParams ||
		body instanceof ArrayBuffer ||
		ArrayBuffer.isView(body)
	) {
		return false;
	}
	if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
		return false;
	}
	return true;
}

/** Case-insensitive header presence check. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) return true;
	}
	return false;
}

/** Delete every case variant of a header from a plain header record. */
function deleteHeader(headers: Record<string, string>, name: string): void {
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) delete headers[key];
	}
}

function originOf(value: string): string | null {
	try {
		if (/^[a-z][a-z\d+\-.]*:\/\//i.test(value)) return new URL(value).origin;
		if (typeof window !== "undefined")
			return new URL(value, window.location.href).origin;
		return null;
	} catch {
		return null;
	}
}

function isCrossOriginAbsoluteUrl(url: string, baseURL: string): boolean {
	if (!/^[a-z][a-z\d+\-.]*:\/\//i.test(url)) return false;
	const targetOrigin = originOf(url);
	if (targetOrigin === null) return true;
	const baseOrigin = baseURL ? originOf(baseURL) : null;
	if (baseOrigin !== null) return targetOrigin !== baseOrigin;
	if (typeof window !== "undefined")
		return targetOrigin !== window.location.origin;
	return true;
}

/** Merge abort signals into one (whichever fires first wins). `undefined` if none. */
function combineSignals(
	signals: ReadonlyArray<AbortSignal | undefined>,
): AbortSignal | undefined {
	const present = signals.filter((s): s is AbortSignal => s !== undefined);
	if (present.length <= 1) return present[0];
	if (typeof AbortSignal.any === "function") return AbortSignal.any(present);
	// Fallback for runtimes without AbortSignal.any.
	const controller = new AbortController();
	for (const signal of present) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			break;
		}
		signal.addEventListener("abort", () => controller.abort(signal.reason), {
			once: true,
		});
	}
	return controller.signal;
}

/** Parse a response by content-type; `null` for empty / no-content bodies. */
async function parseBody(response: Response): Promise<unknown> {
	if (response.status === 204 || response.status === 205) return null;
	const type = response.headers.get("content-type") ?? "";
	const text = await response.text();
	if (text === "") return null;
	if (type.includes("application/json")) return JSON.parse(text);
	return text;
}

export class HttpClient {
	readonly #baseURL: string;
	readonly #headers: Record<string, string>;
	readonly #token?: string | null | (() => string | null | undefined);
	readonly #credentials?: RequestCredentials;
	readonly #timeout?: number;
	readonly #allowCrossOriginAuth: boolean;

	constructor(options: HttpClientOptions = {}) {
		this.#baseURL = options.baseURL ?? "";
		this.#headers = { ...options.headers };
		this.#token = options.token;
		this.#credentials = options.credentials;
		this.#timeout = options.timeout;
		this.#allowCrossOriginAuth = options.allowCrossOriginAuth ?? false;
	}

	/** Set a default header for every subsequent request (case-insensitive replace). Chainable. */
	setHeader(name: string, value: string): this {
		this.#deleteHeader(name);
		this.#headers[name] = value;
		return this;
	}

	/** Merge several default headers at once. Chainable. */
	setHeaders(headers: Record<string, string>): this {
		for (const [name, value] of Object.entries(headers)) {
			this.setHeader(name, value);
		}
		return this;
	}

	/** Remove a default header (case-insensitive). Chainable. */
	removeHeader(name: string): this {
		this.#deleteHeader(name);
		return this;
	}

	/** A copy of the current default headers. */
	getHeaders(): Record<string, string> {
		return { ...this.#headers };
	}

	#deleteHeader(name: string): void {
		const lower = name.toLowerCase();
		for (const key of Object.keys(this.#headers)) {
			if (key.toLowerCase() === lower) delete this.#headers[key];
		}
	}

	get<T>(url: string, options?: HttpRequestOptions<T>): Promise<T> {
		return this.#request("GET", url, undefined, options);
	}

	delete<T>(url: string, options?: HttpRequestOptions<T>): Promise<T> {
		return this.#request("DELETE", url, undefined, options);
	}

	post<T>(
		url: string,
		body?: unknown,
		options?: HttpRequestOptions<T>,
	): Promise<T> {
		return this.#request("POST", url, body, options);
	}

	put<T>(
		url: string,
		body?: unknown,
		options?: HttpRequestOptions<T>,
	): Promise<T> {
		return this.#request("PUT", url, body, options);
	}

	patch<T>(
		url: string,
		body?: unknown,
		options?: HttpRequestOptions<T>,
	): Promise<T> {
		return this.#request("PATCH", url, body, options);
	}

	/** Send a request and return the raw `Response` (no parsing, no throw on non-2xx). */
	raw(
		method: string,
		url: string,
		body?: unknown,
		options: HttpRequestOptions = {},
	): Promise<Response> {
		return this.#send(method, url, body, options);
	}

	/**
	 * Run a request without throwing on a non-2xx response: returns a
	 * discriminated {@link HttpResult} so a form submit can branch
	 * (`if (r.ok) … else r.error.data`) instead of wrapping each call in
	 * try/catch. Genuine transport failures (offline, DNS) still reject —
	 * they're exceptional, not an HTTP error.
	 *
	 * ```js
	 * const r = await api.attempt(api.post('/auth/login', creds))
	 * if (r.ok) user(r.data)
	 * else fieldErrors(r.error.data)   // HttpError.data = parsed 4xx body
	 * ```
	 */
	async attempt<T>(request: Promise<T>): Promise<HttpResult<T>> {
		try {
			return { ok: true, data: await request, error: null };
		} catch (error) {
			if (error instanceof HttpError) {
				return { ok: false, data: null, error };
			}
			throw error;
		}
	}

	/** Derive a new client with merged defaults (e.g. a scope that adds a token). */
	extend(options: HttpClientOptions): HttpClient {
		return new HttpClient({
			baseURL: options.baseURL ?? this.#baseURL,
			headers: { ...this.#headers, ...options.headers },
			token: options.token ?? this.#token,
			credentials: options.credentials ?? this.#credentials,
			timeout: options.timeout ?? this.#timeout,
			allowCrossOriginAuth:
				options.allowCrossOriginAuth ?? this.#allowCrossOriginAuth,
		});
	}

	#resolveToken(override?: string | null): string | null | undefined {
		if (override !== undefined) return override;
		return typeof this.#token === "function" ? this.#token() : this.#token;
	}

	#buildUrl(url: string, query?: HttpRequestOptions["query"]): string {
		const base = /^[a-z][a-z\d+\-.]*:\/\//i.test(url)
			? url
			: this.#baseURL + url;
		if (!query) return base;
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			if (value !== null && value !== undefined)
				params.append(key, String(value));
		}
		const qs = params.toString();
		if (qs === "") return base;
		return `${base}${base.includes("?") ? "&" : "?"}${qs}`;
	}

	#send(
		method: string,
		url: string,
		body: unknown,
		options: HttpRequestOptions,
	): Promise<Response> {
		const finalUrl = this.#buildUrl(url, options.query);
		const crossOrigin = isCrossOriginAbsoluteUrl(finalUrl, this.#baseURL);
		const allowCrossOriginAuth =
			options.allowCrossOriginAuth ?? this.#allowCrossOriginAuth;
		const explicitRequestAuth =
			options.headers !== undefined &&
			hasHeader(options.headers, "authorization");
		const headers: Record<string, string> = {
			...this.#headers,
			...options.headers,
		};
		if (
			crossOrigin &&
			!allowCrossOriginAuth &&
			!explicitRequestAuth &&
			hasHeader(this.#headers, "authorization")
		) {
			deleteHeader(headers, "authorization");
		}
		const token = this.#resolveToken(options.token);
		if (
			token != null &&
			!hasHeader(headers, "authorization") &&
			(!crossOrigin || allowCrossOriginAuth)
		) {
			headers.Authorization = `Bearer ${token}`;
		}

		let payload: BodyInit | undefined;
		if (body !== undefined && body !== null) {
			if (shouldJsonEncode(body)) {
				payload = JSON.stringify(body);
				if (!hasHeader(headers, "content-type")) {
					headers["Content-Type"] = "application/json";
				}
			} else {
				// Already a valid BodyInit (string / FormData / Blob / …).
				payload = body as BodyInit;
			}
		}

		const timeout = options.timeout ?? this.#timeout;
		const signal = combineSignals([
			options.signal,
			timeout !== undefined ? AbortSignal.timeout(timeout) : undefined,
		]);

		return fetch(finalUrl, {
			method,
			headers,
			body: payload,
			signal,
			credentials: options.credentials ?? this.#credentials,
		});
	}

	async #request<T>(
		method: string,
		url: string,
		body: unknown,
		options: HttpRequestOptions<T> = {},
	): Promise<T> {
		const response = await this.#send(method, url, body, options);
		const data = await parseBody(response);
		if (!response.ok) throw new HttpError(response, data);
		// `parse` validates at runtime; without it, `T` is the caller's
		// unchecked assertion of the response shape (the usual HTTP boundary).
		return options.parse ? options.parse(data) : (data as T);
	}
}

/** Default same-origin client. Configure your own via `new HttpClient({ … })`. */
export const http = new HttpClient();
