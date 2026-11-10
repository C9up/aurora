/**
 * The one place that decides whether a URL is safe to put in the document.
 *
 * `navigate()` has refused `javascript:` since it was written. Nothing applied
 * the same rule to the markup, so `html`<a href="${url}">``  rendered whatever
 * it was handed — the policy existed and the attribute that actually navigates
 * was the one place it did not reach. A URL from a user profile, a comment body
 * or a redirect parameter became script on click, in Pagination, Breadcrumb,
 * NavigationMenu and anything else that takes an `href` prop.
 *
 * Extracted rather than copied, for the reason the template scanner was
 * unified: two copies of a rule diverge, and a security rule that diverges
 * fails open on one of the two paths.
 *
 * Unsafe URLs are NEUTRALISED, not rejected. A template is authored code but
 * the URL in it is often data — a profile link, a webhook someone pasted — and
 * throwing there turns hostile content into a blank page, which trades an XSS
 * for a denial of service. Prefixing the scheme leaves the attribute in place,
 * inert, and visible in the DOM to whoever comes looking. Same choice, and the
 * same prefix, as Angular's sanitiser.
 */

/**
 * The attributes whose value the browser will NAVIGATE to or submit to, on
 * whatever element carries them.
 */
const NAVIGATION_ATTRIBUTES: ReadonlySet<string> = new Set([
	"href",
	"xlink:href",
	"action",
	"formaction",
]);

/**
 * The attributes that LOAD something which then runs — but only on these
 * elements.
 *
 * `src` used to be left out everywhere, for the image's sake: a `data:` URI is
 * how an inline image is written, and blocking it on `<img>` breaks legitimate
 * markup to guard a position that runs nothing. On a script it is the opposite:
 * `<script src="data:text/javascript,…">` runs in the page, and an iframe's
 * `javascript:` URL runs in its parent. So the answer depends on the element,
 * and this map is where that dependency is written down.
 */
const EXECUTING_SOURCES: ReadonlyMap<string, string> = new Map([
	["script", "src"],
	["iframe", "src"],
	["frame", "src"],
	["embed", "src"],
	["object", "data"],
]);

/**
 * The SVG animation elements that can set a URL attribute, and the attributes
 * that carry the value they set it to.
 *
 * `<set attributeName="href" to="javascript:…">` gives a link a `javascript:`
 * target no `href` ever held. Which attribute is animated is not known when the
 * value is written — `attributeName` may come after it — so these values are
 * guarded whatever they animate: an opacity never starts with a scheme.
 */
const ANIMATION_ELEMENTS: ReadonlySet<string> = new Set(["set", "animate"]);
const ANIMATION_VALUE_ATTRIBUTES: ReadonlySet<string> = new Set([
	"to",
	"from",
	"by",
	"values",
]);

/**
 * The elements whose URL guard depends on their name. The template scanner
 * tracks their names so the server can ask which one a value belongs to.
 * `meta` for a refresh target in `content`, `base` for the refusal of a dynamic
 * `href` (see `assertBindable`).
 */
export const SOURCE_ELEMENTS: ReadonlySet<string> = new Set([
	...EXECUTING_SOURCES.keys(),
	...ANIMATION_ELEMENTS,
	"meta",
	"base",
]);

/**
 * The DOM properties that write one of those attributes, by the attribute they
 * write.
 *
 * A `.prop` binding reaches the element by assignment, never through
 * `setAttribute`, so the attribute guard never saw it: `<a .href=${url}>` took a
 * `javascript:` URL straight through. Keyed by the property's own spelling —
 * property names are case-sensitive, and `formaction` is not `formAction`.
 */
const URL_PROPERTIES: ReadonlyMap<string, string> = new Map([
	["href", "href"],
	["content", "content"],
	["src", "src"],
	["action", "action"],
	["formAction", "formaction"],
	["data", "data"],
]);

/** The schemes that execute, plus the one that can carry a whole document. */
const UNSAFE_SCHEMES = ["javascript:", "vbscript:", "data:"];

/**
 * What a neutralised URL is prefixed with, leaving it inert but readable.
 *
 * Exported because server-side rendering prefixes the MARKUP of a value rather
 * than the value — it has to hold the whole attribute back and judge it once —
 * and this string needs no escaping, so prepending it to markup is the same
 * operation.
 */
export const UNSAFE_URL_PREFIX = "unsafe:";

/**
 * Drop every C0 control character.
 *
 * Browsers strip ASCII tab, newline and CR from ANYWHERE in a URL and trim
 * leading control characters and whitespace before resolving the scheme, so
 * `java&#9;script:` — or a leading NUL — is evaluated as `javascript:`. A guard
 * that only trims the start is trivially bypassed.
 *
 * Written as a scan rather than a regex: a character class over control
 * characters is exactly what `noControlCharactersInRegex` flags, and the rule is
 * right in general — here the stripping is the point, so the loop states it
 * without needing a suppression.
 */
function stripControlChars(value: string): string {
	let out = "";
	for (const char of value) {
		if (char.charCodeAt(0) > 0x1f) out += char;
	}
	return out;
}

/** True when `url`'s scheme is one the browser would execute. */
export function hasUnsafeScheme(url: string): boolean {
	const normalized = stripControlChars(url).trimStart().toLowerCase();
	return UNSAFE_SCHEMES.some((scheme) => normalized.startsWith(scheme));
}

/**
 * True when `attribute`'s value, on `element`, is somewhere the browser
 * navigates to or loads code from. Both names are compared lowercased, as HTML
 * compares them; an empty `element` is one whose name nobody tracked, which only
 * the navigation attributes can match.
 */
export function isUrlAttribute(element: string, attribute: string): boolean {
	const name = attribute.toLowerCase();
	const tag = element.toLowerCase();
	return (
		NAVIGATION_ATTRIBUTES.has(name) ||
		EXECUTING_SOURCES.get(tag) === name ||
		(ANIMATION_ELEMENTS.has(tag) && ANIMATION_VALUE_ATTRIBUTES.has(name)) ||
		(tag === "meta" && name === "content")
	);
}

/** Is this an animation's `values`, a `;`-separated list of values? */
export function isUrlList(element: string, attribute: string): boolean {
	return (
		ANIMATION_ELEMENTS.has(element.toLowerCase()) &&
		attribute.toLowerCase() === "values"
	);
}

/**
 * The URL a `<meta http-equiv="refresh">` content would navigate to, or null
 * when the content does not read as a refresh — a description, a viewport.
 *
 * Read the way the HTML spec's declarative refresh does, loosely enough to
 * err towards a refresh: a delay of digits and dots, a `;` or `,`, an optional
 * `url=`, an optional quote, then the URL. `http-equiv` may come after the
 * content in the tag, so the content is judged whatever the meta is.
 */
function refreshTarget(content: string): string | null {
	const match =
		/^[\t\n\f\r ]*[0-9.]+[\t\n\f\r ]*[;,]?[\t\n\f\r ]*(?:url[\t\n\f\r ]*=[\t\n\f\r ]*)?["']?([\s\S]*)$/i.exec(
			content,
		);
	return match === null ? null : (match[1] ?? "");
}

/** Would `value`, in `attribute` on `element`, navigate to a scheme that runs? */
export function isUnsafeUrlValue(
	element: string,
	attribute: string,
	value: string,
): boolean {
	if (isUrlList(element, attribute)) {
		return value.split(";").some(hasUnsafeScheme);
	}
	if (element.toLowerCase() === "meta") {
		const target = refreshTarget(value);
		return target !== null && hasUnsafeScheme(target);
	}
	return hasUnsafeScheme(value);
}

/**
 * `value` made inert if it would navigate to a scheme that runs, untouched
 * otherwise: prefixed, or, for a list of values, each unsafe item prefixed.
 */
export function neutralizeUrlValue(
	element: string,
	attribute: string,
	value: string,
): string {
	if (!isUnsafeUrlValue(element, attribute, value)) return value;
	if (isUrlList(element, attribute)) {
		return value
			.split(";")
			.map((item) => (hasUnsafeScheme(item) ? UNSAFE_URL_PREFIX + item : item))
			.join(";");
	}
	return UNSAFE_URL_PREFIX + value;
}

/**
 * The value to write for `attribute` on `element`, neutralised if it would
 * navigate to or load a scheme that executes. Anything else is returned
 * untouched. For a caller that has both names and the whole value — both client
 * render paths, which read them off the parsed DOM.
 */
export function guardUrlAttribute(
	element: string,
	attribute: string,
	value: string,
): string {
	return isUrlAttribute(element, attribute)
		? neutralizeUrlValue(element, attribute, value)
		: value;
}

/**
 * The value to assign to `property` on `element`, neutralised when the property
 * writes a URL attribute that {@link guardUrlAttribute} would have guarded.
 *
 * Anything else — another property, or a value whose text is a safe URL — comes
 * back as it was given, object and all: a `.data` on a custom element is often
 * an object, and turning it into a string would break it for nothing.
 */
export function guardUrlProperty(
	element: string,
	property: string,
	value: unknown,
): unknown {
	const attribute = URL_PROPERTIES.get(property);
	if (attribute === undefined || value === null || value === undefined) {
		return value;
	}
	if (!isUrlAttribute(element, attribute)) return value;
	const url = String(value);
	return isUnsafeUrlValue(element, attribute, url)
		? neutralizeUrlValue(element, attribute, url)
		: value;
}
