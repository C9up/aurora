/**
 * How the page data script is marked, shared by the server that writes it and
 * the bootstraps that read it.
 *
 * Found by an id, it could be stood in for: `getElementById` returns the first
 * element in tree order with that id, of any kind, and the script came after
 * the rendered body. A heading whose `id` came from data, holding JSON that also
 * came from data, became the page's props, its route manifest and, with visits
 * on, the URL its page modules were imported from. The script is now written
 * before the root and found by a selector that only a JSON script matches, as
 * Inertia marks its page object (`script[data-page][type="application/json"]`).
 */

export const PAGE_DATA_ATTRIBUTE = "data-aurora-page";

export const PAGE_DATA_SELECTOR = `script[${PAGE_DATA_ATTRIBUTE}][type="application/json"]`;
