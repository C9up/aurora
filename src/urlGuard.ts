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
 * The attributes whose value the browser will NAVIGATE to or submit to. `src`
 * is deliberately not among them: a `data:` URI is how an inline image is
 * written, and blocking it there would break legitimate markup to guard a
 * position that does not navigate.
 */
const NAVIGATION_ATTRIBUTES: ReadonlySet<string> = new Set([
	"href",
	"xlink:href",
	"action",
	"formaction",
]);

/** The schemes that execute, plus the one that can carry a whole document. */
const UNSAFE_SCHEMES = ["javascript:", "vbscript:", "data:"];

/** What a neutralised URL is prefixed with, leaving it inert but readable. */
const NEUTRALISED = "unsafe:";

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

/** True when this attribute's value is somewhere the browser navigates to. */
export function isNavigationAttribute(attribute: string): boolean {
	return NAVIGATION_ATTRIBUTES.has(attribute.toLowerCase());
}

/**
 * `url` made inert if its scheme executes, untouched otherwise. For a caller
 * that has already established the position navigates — server-side rendering
 * knows it from the scanner before it escapes the value.
 */
export function neutralizeUnsafeUrl(url: string): string {
	return hasUnsafeScheme(url) ? NEUTRALISED + url : url;
}

/**
 * The value to write for `attribute`, neutralised if it would navigate to a
 * scheme that executes. Anything else is returned untouched. For a caller that
 * has the attribute name and the whole value — both client render paths, which
 * read the name off the parsed DOM.
 */
export function guardUrlAttribute(attribute: string, value: string): string {
	return isNavigationAttribute(attribute) ? neutralizeUnsafeUrl(value) : value;
}
