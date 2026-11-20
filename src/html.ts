/**
 * Tagged-template HTML.
 *
 *   html`<button @click="${onClick}">${count}</button>`
 *
 * returns a `TemplateResult`: the strings and the values, nothing else. What
 * the template becomes is the renderer's business — the DOM renderer compiles
 * it once per strings array (`compile.ts`), the server renders it to a string
 * (`ssr.ts`), a native renderer maps it to native views. That is why this
 * module touches no host: it is part of the host-free core.
 *
 * The syntax is intentionally minimal — text interpolation (`>${x}<`),
 * attribute interpolation (`attr="${x}"` and multi-slot
 * `class="a ${x} b ${y}"`), boolean attributes (`?disabled="${x}"`), DOM
 * properties (`.value="${x}"`), and event listeners (`@click="${fn}"`).
 * No custom directives, no fragments-in-attribute-name, no comment-only
 * placeholders.
 */

import { rememberContext } from "./component.js";
import {
	isTemplateResult,
	TEMPLATE_RESULT_BRAND,
	type TemplateResult,
} from "./types.js";

/**
 * Tagged-template entrypoint. The `strings` array is reference-stable per
 * source location (TC39 guarantee), so caching by reference is safe and
 * O(1) on the hot render path.
 */
export function html(
	strings: TemplateStringsArray,
	...values: unknown[]
): TemplateResult {
	const result: TemplateResult = {
		strings,
		values,
		[TEMPLATE_RESULT_BRAND]: true,
	};
	rememberContext(result, values);
	return result;
}

export { isTemplateResult };
