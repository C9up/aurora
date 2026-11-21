import { component, html, onUnmount } from "../../../src/index.js";

/** Counts its unmounts, so a test sees the page end when a visit leaves it. */
export const ended = { count: 0 };

export default component((props: { title?: string }) => {
	onUnmount(() => {
		ended.count += 1;
	});
	return html`<section data-page="home"><h1>${props.title ?? "Home"}</h1><a href="/second">Second</a><a href="/away" data-photon="external">Away</a></section>`;
});
