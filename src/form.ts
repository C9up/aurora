/**
 * `form()` — a minimal reactive form controller: per-field `value` / `error` /
 * `touched` signals, validation, and a submit driven by {@link command} (so the
 * submit's `loading` / `error` are reactive too). Call sites bind the signals in
 * `html\`\`` and never hand-roll field state or try/catch.
 *
 * Validation is OPTIONAL and **agnostic**: pass a `validate` function returning a
 * `{ field: message }` map, OR any object with a `.validate(values)` method
 * (e.g. a `@c9up/rune` schema) — aurora never imports a validator, it only
 * duck-types `.validate`. With no `validate`, the form simply never reports field
 * errors. Node-free — part of the client barrel.
 *
 * ```js
 * import { form, HttpClient, isHttpError } from '@c9up/aurora'
 * import { rules, schema } from '@c9up/rune'   // optional
 * const api = new HttpClient()
 *
 * const f = form({
 *   initial: { email: '', password: '' },
 *   validate: schema({ email: rules.string().email(), password: rules.string().min(8) }),
 *   submit: (values) => api.post('/auth/login', values),
 * })
 *   .onSuccess(() => redirect('/app'))
 *   .onFail((e) => { if (isHttpError(e)) f.setErrors(e.data?.errors ?? {}) })
 *
 * const email = f.field('email')
 * // <input value=${email.value} @input=${(e) => email.set(e.target.value)} @blur=${email.markTouched}>
 * // <button ?disabled=${f.submitting} @click=${(e) => f.handleSubmit(e)}>
 * ```
 */

import { command } from "./command.js";
import { memo, type ReadSignal, signal } from "./reactive.js";

/** A field-keyed error map: `{ email: "Invalid", … }`. Absent key ⇒ no error. */
export type FieldErrors<T> = Partial<Record<keyof T, string>>;

/** Anything `.validate()`-shaped (a `@c9up/rune` schema satisfies this). */
export interface FormSchema<T> {
	validate(values: T): {
		valid: boolean;
		errors?: ReadonlyArray<{ field?: string; message: string }>;
	};
}

/** Validation source — a function, a schema-like object, or omitted. */
export type FormValidate<T> = ((values: T) => FieldErrors<T>) | FormSchema<T>;

export interface FormOptions<T> {
	/** Initial field values; its keys define the form's fields. */
	initial: T;
	/** The submit task (wrapped in a {@link command}). */
	submit: (values: T) => Promise<unknown>;
	/** Optional, agnostic validation (function OR `.validate`-shaped object). */
	validate?: FormValidate<T>;
}

/** A single field's reactive handles + setters. */
export interface FormField<V> {
	readonly value: ReadSignal<V>;
	readonly error: ReadSignal<string | null>;
	readonly touched: ReadSignal<boolean>;
	set(value: V): void;
	markTouched(): void;
}

export interface Form<T> {
	readonly values: ReadSignal<T>;
	readonly errors: ReadSignal<FieldErrors<T>>;
	/** Whether the last validation found no errors. */
	readonly valid: ReadSignal<boolean>;
	/** Whether the submit is in flight (the submit command's loading). */
	readonly submitting: ReadSignal<boolean>;
	/** The submit command's last error. */
	readonly submitError: ReadSignal<unknown>;
	field<K extends keyof T>(key: K): FormField<T[K]>;
	set<K extends keyof T>(key: K, value: T[K]): void;
	/** Run validation now, populate `errors`, and return whether it passed. */
	validate(): boolean;
	/** Validate then submit (no-op if invalid). Calls `event.preventDefault()`. */
	handleSubmit(event?: { preventDefault(): void }): Promise<void>;
	/** Merge in errors (e.g. server-side field errors from `HttpError.data`). */
	setErrors(errors: FieldErrors<T>): void;
	/** Reset values to `initial` and clear errors / touched / submit state. */
	reset(): void;
	/** Submit success handler (chainable) — receives the resolved value. */
	onSuccess(handler: (data: unknown) => void): this;
	/** Submit failure handler (chainable) — receives the thrown error. */
	onFail(handler: (error: unknown) => void): this;
}

/** Normalize any validation source into a field-error map. */
function computeErrors<T>(
	validate: FormValidate<T> | undefined,
	values: T,
): FieldErrors<T> {
	if (!validate) return {};
	if (typeof validate === "function") return validate(values);
	const result = validate.validate(values);
	if (result.valid) return {};
	const errors: Record<string, string> = {};
	for (const issue of result.errors ?? []) {
		if (issue.field && !(issue.field in errors)) {
			errors[issue.field] = issue.message;
		}
	}
	// Boundary: a schema's errors are string-keyed and it doesn't know `keyof T`,
	// so narrow the validated key space to the form's field type here.
	return errors as FieldErrors<T>;
}

class FormController<T> implements Form<T> {
	readonly #initial: T;
	readonly #validate?: FormValidate<T>;
	readonly #values: ReturnType<typeof signal<T>>;
	readonly #errors = signal<FieldErrors<T>>({});
	readonly #touched = signal<ReadonlySet<string>>(new Set());
	readonly #command: ReturnType<typeof command<[T], unknown>>;

	readonly values: ReadSignal<T>;
	readonly errors: ReadSignal<FieldErrors<T>> = this.#errors;
	readonly valid: ReadSignal<boolean>;
	readonly submitting: ReadSignal<boolean>;
	readonly submitError: ReadSignal<unknown>;

	constructor(options: FormOptions<T>) {
		this.#initial = { ...options.initial };
		this.#validate = options.validate;
		this.#values = signal<T>({ ...options.initial });
		this.values = this.#values;
		this.#command = command((values: T) => options.submit(values));
		this.submitting = this.#command.loading;
		this.submitError = this.#command.error;
		this.valid = memo(() =>
			Object.values(this.#errors()).every((message) => !message),
		);
	}

	field<K extends keyof T>(key: K): FormField<T[K]> {
		return {
			value: memo(() => this.#values()[key]),
			error: memo(() => this.#errors()[key] ?? null),
			touched: memo(() => this.#touched().has(String(key))),
			set: (value: T[K]) => this.set(key, value),
			markTouched: () => this.#markTouched(key),
		};
	}

	set<K extends keyof T>(key: K, value: T[K]): void {
		const next = { ...this.#values() };
		next[key] = value;
		this.#values(next);
		// Clear a stale error for this field as the user edits it.
		if (this.#errors()[key] !== undefined) {
			const errors = { ...this.#errors() };
			delete errors[key];
			this.#errors(errors);
		}
	}

	validate(): boolean {
		const errors = computeErrors(this.#validate, this.#values());
		this.#errors(errors);
		return Object.values(errors).every((message) => !message);
	}

	async handleSubmit(event?: { preventDefault(): void }): Promise<void> {
		event?.preventDefault();
		this.#touched(new Set(Object.keys(this.#values() as object)));
		if (!this.validate()) return;
		await this.#command.run(this.#values());
	}

	setErrors(errors: FieldErrors<T>): void {
		this.#errors({ ...this.#errors(), ...errors });
	}

	reset(): void {
		this.#values({ ...this.#initial });
		this.#errors({});
		this.#touched(new Set());
		this.#command.reset();
	}

	onSuccess(handler: (data: unknown) => void): this {
		this.#command.onSuccess(handler);
		return this;
	}

	onFail(handler: (error: unknown) => void): this {
		this.#command.onFail(handler);
		return this;
	}

	#markTouched(key: keyof T): void {
		this.#touched(new Set(this.#touched()).add(String(key)));
	}
}

/** Create a reactive {@link Form} controller. See the module doc for usage. */
export function form<T>(options: FormOptions<T>): Form<T> {
	return new FormController(options);
}
