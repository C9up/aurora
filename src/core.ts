/**
 * `@c9up/aurora/core` — the host-free core.
 *
 * Everything a component is written with, and nothing that needs a host: no
 * DOM, no Node module, no top-level await. The same component file runs on the
 * server (SSR), in the browser (the DOM renderer, `@c9up/aurora`) and on a
 * phone (a native renderer, which reads the `TemplateResult` these return and
 * builds native views). A renderer adds the host; this entry never does.
 *
 * `@c9up/aurora` re-exports all of it, so an existing app changes nothing.
 * Import from here in code that must run on every host.
 */

export { type ClassValue, clsx, cn, twMerge } from "./cn.js";
export type { Command } from "./command.js";
export { command } from "./command.js";
export {
	type Context,
	component,
	createContext,
	inject,
	onMount,
	onUnmount,
	provide,
} from "./component.js";
export { type Each, type EachItems, each, isEach } from "./each.js";
export { AuroraError, type AuroraErrorCode } from "./errors.js";
export type {
	FieldErrors,
	Form,
	FormField,
	FormOptions,
	FormSchema,
	FormValidate,
} from "./form.js";
export { form } from "./form.js";
export { html, isTemplateResult } from "./html.js";
export { uid, withIdScope } from "./id.js";
export {
	batch,
	effect,
	isSignal,
	memo,
	onCleanup,
	type ReadSignal,
	type Signal,
	signal,
	untrack,
} from "./reactive.js";
export {
	countRerenders,
	type RerenderCounter,
	type RerenderEvent,
	type RerenderKind,
	type RerenderOptions,
} from "./rerenders.js";
export type { Disposer, TemplateResult } from "./types.js";
