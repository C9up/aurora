import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	html,
	hydrate,
	render,
	renderToString,
	signal,
} from "../../src/index.js";

/**
 * The positions where a value stops being data and starts being code.
 *
 * Every refusal below comes with its other half: the markup aurora used to emit,
 * landed in this browser, and shown to run. A refusal without that proof says
 * nothing about whether it mattered — and each of these was reported by an audit
 * that ran it in Chromium, so the tests run it in Chromium too.
 */

const PROBE = "__auroraExecutionProbe";

let container: HTMLElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	Reflect.deleteProperty(window, PROBE);
});

afterEach(() => {
	container.remove();
	Reflect.deleteProperty(window, PROBE);
});

/**
 * Put markup in the document without running it — enough to read what the
 * parser built.
 */
function land(markup: string): void {
	container.append(document.createRange().createContextualFragment(markup));
}

/**
 * What `markup` does when a browser loads it as a page, which is what a server
 * response is. Read back from the frame's own window.
 *
 * A same-origin `srcdoc` frame rather than a fragment in this document: a
 * contextual fragment runs an HTML script but not an SVG one, so it would have
 * "proved" the SVG hole did not exist.
 */
async function runsInPage(markup: string): Promise<unknown> {
	const frame = document.createElement("iframe");
	const loaded = new Promise((resolve) => {
		frame.addEventListener("load", resolve, { once: true });
	});
	frame.srcdoc = `<!doctype html><body>${markup}`;
	container.append(frame);
	await loaded;
	await settle();
	return Reflect.get(frame.contentWindow ?? {}, PROBE);
}

/** The attribute the browser reads after parsing `markup`. */
function parsedAttribute(markup: string, selector: string, name: string) {
	const doc = new DOMParser().parseFromString(markup, "text/html");
	return doc.querySelector(selector)?.getAttribute(name);
}

/** Let a script load, an iframe navigate or an image fail. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 200));
}

function probe(): unknown {
	return Reflect.get(window, PROBE);
}

/** A value that runs once the `<!--$-->` marker's line comment ends. */
const PAYLOAD = `\nwindow.${PROBE} = 42`;

describe("aurora > browser > a script inside SVG", () => {
	it("runs, so what the server used to emit there was live code", async () => {
		expect(
			await runsInPage(
				`<svg><script><!--$-->${PAYLOAD}<!--/$--></script></svg>`,
			),
		).toBe(42);
		// No newline needed: in foreign content the marker is a real comment
		// node, and the script's text is what is left around it.
		expect(
			await runsInPage(
				`<svg><script><!--$-->window.${PROBE} = 42<!--/$--></script></svg>`,
			),
		).toBe(42);
	});

	it("refuses the slot on both paths", () => {
		const make = () => html`<svg><script>${PAYLOAD}</script></svg>`;
		expect(() => renderToString(make())).toThrowError(
			/cannot go inside <script>/,
		);
		expect(() => render(make(), container)).toThrowError(
			/cannot go inside <script>/,
		);
		expect(probe()).toBeUndefined();
	});

	it("refuses one in an SVG <style> too, which is CSS whatever the namespace", () => {
		expect(() =>
			renderToString(html`<svg><style>${"a{}"}</style></svg>`),
		).toThrowError(/cannot go inside <style>/);
	});

	it("still takes a slot in <svg><title> and <svg><text>", () => {
		const markup = renderToString(
			html`<svg><title>${"Revenue"}</title><text>${"42"}</text></svg>`,
		);
		land(markup);
		expect(container.querySelector("svg title")?.textContent).toContain(
			"Revenue",
		);
		expect(container.querySelector("svg text")?.textContent).toContain("42");
	});

	it("takes attribute slots on the script element itself", () => {
		const markup = renderToString(html`<svg><script id=${"s"}></script></svg>`);
		expect(parsedAttribute(markup, "script", "id")).toBe("s");
	});
});

describe("aurora > browser > an HTML tag that breaks out of SVG", () => {
	it("really does take the parser back to HTML", () => {
		land("<svg><p></p><title>t</title></svg>");
		const title = container.querySelector("title");
		expect(title?.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
	});

	it("puts the raw-text rules back in force", () => {
		for (const make of [
			() => html`<svg><p><textarea>${"v"}</textarea></p></svg>`,
			() => html`<svg><div></div><title>${"t"}</title></svg>`,
			() => html`<svg><br/><script>${"var a"}</script></svg>`,
		]) {
			expect(() => renderToString(make())).toThrowError(/cannot go inside/);
		}
	});

	it("leaves plain SVG alone after the breakout closes the SVG", () => {
		expect(renderToString(html`<svg><rect/></svg><p>${"after"}</p>`)).toContain(
			"after",
		);
	});
});

describe("aurora > browser > MathML's text integration points", () => {
	it("are where a script becomes an HTML script that runs", async () => {
		expect(
			await runsInPage(
				`<math><mtext><script><!--$-->${PAYLOAD}<!--/$--></script></mtext></math>`,
			),
		).toBe(42);
	});

	it("refuse the slot in each of mi, mo, mn, ms and mtext", () => {
		for (const make of [
			() => html`<math><mi><script>${"var a"}</script></mi></math>`,
			() => html`<math><mo><script>${"var a"}</script></mo></math>`,
			() => html`<math><mn><script>${"var a"}</script></mn></math>`,
			() => html`<math><ms><script>${"var a"}</script></ms></math>`,
			() => html`<math><mtext><script>${"var a"}</script></mtext></math>`,
		]) {
			expect(() => renderToString(make())).toThrowError(
				/cannot go inside <script>/,
			);
		}
	});

	it("still take an ordinary text slot", () => {
		land(renderToString(html`<math><mi>${"x"}</mi></math>`));
		expect(container.querySelector("mi")?.textContent).toContain("x");
	});
});

describe("aurora > browser > a URL whose danger depends on the element", () => {
	const SCRIPT_URL = `data:text/javascript,window.${PROBE}=42`;
	const FRAME_URL = `javascript:parent.${PROBE}=42`;

	it("runs from a script's src and an iframe's src", async () => {
		expect(await runsInPage(`<script src="${SCRIPT_URL}"></script>`)).toBe(42);
		expect(await runsInPage(`<iframe src="${FRAME_URL}"></iframe>`)).toBe(42);
	});

	it("is neutralised by the server", async () => {
		const markup = renderToString(
			html`<iframe src="${FRAME_URL}"></iframe><embed src=${FRAME_URL}><frame src=${FRAME_URL}><object data=${FRAME_URL}></object>`,
		);
		expect(parsedAttribute(markup, "iframe", "src")).toBe(
			`unsafe:${FRAME_URL}`,
		);
		expect(parsedAttribute(markup, "embed", "src")).toBe(`unsafe:${FRAME_URL}`);
		expect(parsedAttribute(markup, "object", "data")).toBe(
			`unsafe:${FRAME_URL}`,
		);
		expect(markup).toContain("unsafe:javascript:parent");
		expect(await runsInPage(markup)).toBeUndefined();
	});

	it("is neutralised by the client render", async () => {
		render(html`<iframe src=${FRAME_URL}></iframe>`, container);
		await settle();
		expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
			`unsafe:${FRAME_URL}`,
		);
		expect(probe()).toBeUndefined();
	});

	it("is neutralised when hydration updates it", async () => {
		const url = signal("about:blank");
		const factory = () => html`<iframe src=${url}></iframe>`;
		container.innerHTML = renderToString(factory());
		hydrate(container, factory);
		url(FRAME_URL);
		await settle();
		expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
			`unsafe:${FRAME_URL}`,
		);
		expect(probe()).toBeUndefined();
	});

	it("is left alone where it only shows an image", () => {
		const image = "data:image/png;base64,iVBORw0KGgo=";
		expect(
			parsedAttribute(renderToString(html`<img src=${image}>`), "img", "src"),
		).toBe(image);
		render(html`<img src=${image}>`, container);
		expect(container.querySelector("img")?.getAttribute("src")).toBe(image);
	});
});

describe("aurora > browser > the URL a script loads", () => {
	it("runs whatever it points at, with no scheme a check could catch", async () => {
		const blob = URL.createObjectURL(
			new Blob([`window.${PROBE} = 42`], { type: "text/javascript" }),
		);
		try {
			expect(await runsInPage(`<script src="${blob}"></script>`)).toBe(42);
			// The same through the markup the server used to emit, which only
			// neutralised javascript:, vbscript: and data:.
			expect(
				await runsInPage(`<svg><script href="${blob}"></script></svg>`),
			).toBe(42);
		} finally {
			URL.revokeObjectURL(blob);
		}
	});

	it("is refused on both paths, in HTML and in SVG", () => {
		for (const make of [
			() => html`<script src=${"blob:x"}></script>`,
			() =>
				html`<script type="module" src="${"https://cdn.example/x.js"}"></script>`,
			() => html`<script src="/assets/${"app"}.js"></script>`,
			() => html`<svg><script href=${"blob:x"}></script></svg>`,
			() => html`<svg><script xlink:href=${"blob:x"}></script></svg>`,
		]) {
			expect(() => renderToString(make())).toThrowError(
				/cannot go in "(src|href|xlink:href)" on <script>/,
			);
			expect(() => render(make(), container)).toThrowError(
				/cannot go in "(src|href|xlink:href)" on <script>/,
			);
		}
		expect(probe()).toBeUndefined();
	});

	it("is refused as a property too", () => {
		const make = () => html`<script .src=${"blob:x"}></script>`;
		expect(() => render(make(), container)).toThrowError(
			/cannot bind \.src on <script>/,
		);
		expect(() => renderToString(make())).toThrowError(
			/cannot bind \.src on <script>/,
		);
	});

	it("leaves every other element's src and href to the scheme check", () => {
		const markup = renderToString(
			html`<img src=${"https://cdn.example/x.png"}><a href=${"https://example.com/"}>x</a>`,
		);
		expect(parsedAttribute(markup, "img", "src")).toBe(
			"https://cdn.example/x.png",
		);
		expect(parsedAttribute(markup, "a", "href")).toBe("https://example.com/");
	});
});

describe("aurora > browser > properties that parse HTML", () => {
	it("run what they are given", async () => {
		const div = document.createElement("div");
		container.append(div);
		div.innerHTML = `<img src="x" onerror="window.${PROBE}=42">`;
		await settle();
		expect(probe()).toBe(42);
	});

	it("are refused on both paths", () => {
		const markup = `<img src="x" onerror="window.${PROBE}=42">`;
		for (const make of [
			() => html`<div .innerHTML=${markup}></div>`,
			() => html`<div .outerHTML=${markup}></div>`,
			() => html`<iframe .srcdoc=${markup}></iframe>`,
		]) {
			expect(() => render(make(), container)).toThrowError(
				/E_AURORA_SLOT_IN_HTML_PROPERTY|cannot bind/,
			);
			expect(() => renderToString(make())).toThrowError(/cannot bind/);
		}
		expect(probe()).toBeUndefined();
	});

	it("leave the text properties alone", () => {
		render(html`<p .textContent=${"<b>x</b>"}></p>`, container);
		expect(container.querySelector("p")?.textContent).toBe("<b>x</b>");
	});
});

describe("aurora > browser > properties that navigate", () => {
	it("are neutralised like the attributes they stand for", async () => {
		const url = `javascript:window.${PROBE}=42`;
		render(html`<a .href=${url}>x</a>`, container);
		const link = container.querySelector("a");
		expect(link?.getAttribute("href")).toBe(`unsafe:${url}`);
		link?.click();
		await settle();
		expect(probe()).toBeUndefined();
	});

	it("depend on the element, as the attributes do", () => {
		const image = "data:image/png;base64,iVBORw0KGgo=";
		const frame = `javascript:parent.${PROBE}=42`;
		render(html`<iframe .src=${frame}></iframe><img .src=${image}>`, container);
		expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
			`unsafe:${frame}`,
		);
		expect(container.querySelector("img")?.getAttribute("src")).toBe(image);
	});
});

describe("aurora > browser > <plaintext>", () => {
	it("has no end tag the browser honours", () => {
		land("<plaintext></plaintext><p>x</p>");
		expect(container.querySelector("p")).toBeNull();
	});

	it("so every slot after it is refused", () => {
		expect(() =>
			renderToString(html`<plaintext></plaintext><p>${"x"}</p>`),
		).toThrowError(/cannot go inside <plaintext>/);
	});
});

describe("aurora > browser > a self-closing slash", () => {
	it("is ignored on an HTML element, so <script/> opens a script that runs", async () => {
		expect(
			await runsInPage(`<script/><!--$-->${PAYLOAD}<!--/$--></script>`),
		).toBe(42);
	});

	it("does not close an HTML element, so the slot after it is refused", () => {
		for (const make of [
			() => html`<script/>${PAYLOAD}</script>`,
			() => html`<style/>${"a{}"}</style>`,
			() => html`<textarea/>${"v"}</textarea>`,
			() =>
				html`<svg><foreignObject><script/>${PAYLOAD}</script></foreignObject></svg>`,
			() => html`<math><mtext><script/>${PAYLOAD}</script></mtext></math>`,
		]) {
			expect(() => renderToString(make())).toThrowError(/cannot go inside/);
			expect(() => render(make(), container)).toThrowError(/cannot go inside/);
		}
		expect(probe()).toBeUndefined();
	});

	it("only counts right before the >, so <svg><script/ > still opens one", async () => {
		expect(
			await runsInPage(
				`<svg><script/ ><!--$-->window.${PROBE} = 42<!--/$--></script></svg>`,
			),
		).toBe(42);
		expect(() =>
			renderToString(html`<svg><script/ >${PAYLOAD}</script></svg>`),
		).toThrowError(/cannot go inside <script>/);
	});

	it("does close an element in foreign content, and <svg/> itself", () => {
		const markup = renderToString(
			html`<svg><desc/><script/><title>${"t"}</title></svg><svg/><p>${"after"}</p>`,
		);
		land(markup);
		expect(container.querySelector("svg title")?.textContent).toContain("t");
		expect(container.querySelector("p")?.textContent).toContain("after");
	});
});

describe("aurora > browser > properties that write a script's source", () => {
	it("run what they are given once the script is inserted", async () => {
		for (const property of ["text", "textContent", "innerText"]) {
			const script = document.createElement("script");
			Reflect.set(script, property, `window.${PROBE} = "${property}"`);
			container.append(script);
			await settle();
			expect(probe()).toBe(property);
			Reflect.deleteProperty(window, PROBE);
		}
	});

	it("are refused on a script or a style, on both paths", () => {
		const code = `window.${PROBE} = 42`;
		for (const make of [
			() => html`<script .text=${code}></script>`,
			() => html`<script .textContent=${code}></script>`,
			() => html`<script .innerText=${code}></script>`,
			() => html`<svg><script .textContent=${code}></script></svg>`,
			() => html`<style .textContent=${"a{}"}></style>`,
		]) {
			expect(() => render(make(), container)).toThrowError(/cannot bind/);
			expect(() => renderToString(make())).toThrowError(/cannot bind/);
		}
		expect(probe()).toBeUndefined();
	});
});

describe("aurora > browser > .value on a file input", () => {
	it("throws in the DOM itself for anything but an empty string", () => {
		const input = document.createElement("input");
		input.type = "file";
		expect(() => {
			input.value = "x";
		}).toThrowError(/InvalidStateError|value/);
		input.value = "";
		expect(input.value).toBe("");
	});

	it("is refused by aurora on both client paths, naming the binding", () => {
		const factory = () => html`<input type="file" .value=${"x"}>`;
		expect(() => render(factory(), container)).toThrowError(
			/E_AURORA_FILE_INPUT_VALUE|cannot set \.value on <input type="file">/,
		);
		container.replaceChildren();
		container.innerHTML = renderToString(factory());
		expect(() => hydrate(container, factory)).toThrowError(
			/cannot set \.value on <input type="file">/,
		);
	});

	it("still clears the field with an empty string", () => {
		const value = signal("");
		const factory = () => html`<input type="file" .value=${value}>`;
		container.innerHTML = renderToString(factory());
		expect(() => hydrate(container, factory)).not.toThrow();
		value("");
		expect(container.querySelector("input")?.value).toBe("");
	});
});
