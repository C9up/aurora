import { html } from "../../../src/index.js";

export default function Hello(props) {
	return html`<p data-name="${props.name}">Hello, ${props.name}!</p>`;
}
