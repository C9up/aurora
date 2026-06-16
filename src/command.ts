/**
 * `command()` — wrap an async task (typically an `HttpClient` call) with reactive
 * `loading` / `data` / `error` signals plus `onSuccess` / `onFail` handlers and a
 * `run(...args)` launcher, so call sites never write `then`/`catch` or
 * `await`+try/catch.
 *
 * `run` is re-runnable with different arguments each time; the signals reflect
 * the LATEST run. A superseded (slower) run that resolves after a newer one is
 * silently dropped — it never overwrites the latest state — which makes
 * re-running safe for search-as-you-type / retry. Node-free — part of the client
 * barrel.
 *
 * ```js
 * import { command, HttpClient, isHttpError } from '@c9up/aurora'
 * const api = new HttpClient()
 *
 * const login = command((creds) => api.post('/auth/login', creds))
 *   .onSuccess((u) => { user(u); redirect('/app') })
 *   .onFail((e) => formError(isHttpError(e) ? e.data : 'Network error'))
 *
 * login.run(creds())          // launch — no try/catch
 * // bind login.loading() for a spinner / disabled button
 * ```
 */

import { type ReadSignal, signal } from "./reactive.js";

export interface Command<TArgs extends unknown[], TData> {
	/** Latest successful result, or `null` before the first success / after `reset`. */
	readonly data: ReadSignal<TData | null>;
	/** Latest run's error, or `null` when none. */
	readonly error: ReadSignal<unknown>;
	/** Whether the latest run is in flight. */
	readonly loading: ReadSignal<boolean>;
	/** Register a success handler (chainable; multiple allowed). */
	onSuccess(handler: (data: TData) => void): this;
	/** Register a failure handler — receives the thrown error (chainable). */
	onFail(handler: (error: unknown) => void): this;
	/** Register a handler that runs after success OR failure (chainable). */
	onSettled(handler: () => void): this;
	/** Launch the task with `args`. Always resolves (errors route to `onFail`). */
	run(...args: TArgs): Promise<void>;
	/** Clear `data`/`error`/`loading` and invalidate any in-flight run. */
	reset(): void;
}

class CommandRunner<TArgs extends unknown[], TData>
	implements Command<TArgs, TData>
{
	readonly #task: (...args: TArgs) => Promise<TData>;
	readonly #data = signal<TData | null>(null);
	readonly #error = signal<unknown>(null);
	readonly #loading = signal(false);
	readonly #onSuccess: Array<(data: TData) => void> = [];
	readonly #onFail: Array<(error: unknown) => void> = [];
	readonly #onSettled: Array<() => void> = [];
	#runId = 0;

	readonly data: ReadSignal<TData | null> = this.#data;
	readonly error: ReadSignal<unknown> = this.#error;
	readonly loading: ReadSignal<boolean> = this.#loading;

	constructor(task: (...args: TArgs) => Promise<TData>) {
		this.#task = task;
	}

	onSuccess(handler: (data: TData) => void): this {
		this.#onSuccess.push(handler);
		return this;
	}

	onFail(handler: (error: unknown) => void): this {
		this.#onFail.push(handler);
		return this;
	}

	onSettled(handler: () => void): this {
		this.#onSettled.push(handler);
		return this;
	}

	reset(): void {
		this.#runId++; // invalidate any in-flight run so it can't write back
		this.#data(null);
		this.#error(null);
		this.#loading(false);
	}

	async run(...args: TArgs): Promise<void> {
		const id = ++this.#runId;
		this.#loading(true);
		this.#error(null);
		try {
			const result = await this.#task(...args);
			if (id !== this.#runId) return; // superseded by a newer run — drop
			this.#data(result);
			for (const handler of this.#onSuccess) handler(result);
		} catch (error) {
			if (id !== this.#runId) return; // superseded — drop
			this.#error(error);
			for (const handler of this.#onFail) handler(error);
		} finally {
			if (id === this.#runId) {
				this.#loading(false);
				for (const handler of this.#onSettled) handler();
			}
		}
	}
}

/**
 * Create a re-runnable {@link Command} around an async `task`. See the module
 * doc for usage.
 */
export function command<TArgs extends unknown[], TData>(
	task: (...args: TArgs) => Promise<TData>,
): Command<TArgs, TData> {
	return new CommandRunner(task);
}
