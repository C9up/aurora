/**
 * `@c9up/aurora/renderer` — what a renderer for another host builds on.
 *
 * aurora ships two renderers of its own (the DOM, and the server's string
 * renderer); a native renderer lives in its own package and reads the same
 * `TemplateResult`. To behave like the others it needs the pieces they share:
 *
 * - the template scanner, so a slot position refused on the web is refused on
 *   every host (`TemplateScanner`, `assertBindable`, `assertBindableProperty`);
 * - the component lifecycle a `component()` stitches onto its result
 *   (`readComponentLifecycle`), and the context a slot's functions run under
 *   (`bindTemplateContext`);
 * - the reactive owner, so effects created while building a subtree are
 *   disposed with it (`setOwner`);
 * - keyed lists (`readEach`, `readEachItems`), and a lazy list's window
 *   (`firstWindow`, `LazyLayout`): which rows exist and how tall the spacers
 *   standing in for the others are, so every host picks the same rows;
 * - the URL guards every host applies to a URL-bearing attribute.
 *
 * Host-free like `@c9up/aurora/core`. Application code does not need it.
 */

export {
	bindTemplateContext,
	type ComponentLifecycle,
	readComponentLifecycle,
} from "./component.js";
export { type EachList, readEach, readEachItems } from "./each.js";
export {
	firstWindow,
	LazyLayout,
	type LazyList,
	type LazyView,
	type LazyWindow,
	sameWindow,
} from "./lazy.js";
export { setOwner } from "./reactive.js";
export {
	assertBindable,
	assertBindableProperty,
	type BindablePosition,
	TemplateScanner,
} from "./templateScanner.js";
export {
	type EffectCallback,
	isTemplateResult,
	type TemplateResult,
} from "./types.js";
export { guardUrlAttribute, guardUrlProperty } from "./urlGuard.js";
