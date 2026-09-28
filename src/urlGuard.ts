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
 * The elements whose URL guard depends on their name. The template scanner
 * tracks their names so the server can ask which one a value belongs to.
 */
export const SOURCE_ELEMENTS: ReadonlySet<string> = new Set(
	EXECUTING_SOURCES.keys(),
);

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
	return (
		NAVIGATION_ATTRIBUTES.has(name) ||
		EXECUTING_SOURCES.get(element.toLowerCase()) === name
	);
}

/**
 * `url` made inert if its scheme executes, untouched otherwise. For a caller
 * that has already established the position navigates — server-side rendering
 * knows it from the scanner before it escapes the value.
 */
export function neutralizeUnsafeUrl(url: string): string {
	return hasUnsafeScheme(url) ? UNSAFE_URL_PREFIX + url : url;
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
		? neutralizeUnsafeUrl(value)
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
	return hasUnsafeScheme(url) ? UNSAFE_URL_PREFIX + url : value;
}
