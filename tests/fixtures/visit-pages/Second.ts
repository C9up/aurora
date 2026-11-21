import { html } from "../../../src/index.js";

export default function Second(props: { n?: number }) {
	return html`<section data-page="second"><p>Second ${props.n ?? 0}</p></section>`;
}
