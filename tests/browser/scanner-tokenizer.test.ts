import { describe, expect, it } from "vitest";
import { html, hydrate, renderToString, signal } from "../../src/index.js";

/**
 * Chromium's own tokenizer as the referee for where the scanner says a slot
 * is. A slot it accepts must not land in a script's text, an `on*` attribute
 * or `srcdoc` once Chromium parses the server's markup; and the shapes the
 * scanner used to misread are refused.
 */

const SENTINEL = "zq9sentinel";

function codeOf(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return Reflect.get(Object(error), "code");
	}
	return undefined;
}

function landedInCode(markup: string): boolean {
	const template = document.createElement("template");
	template.innerHTML = markup;
	const walker = document.createTreeWalker(template.content);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeType === 3 && node.nodeValue?.includes(SENTINEL)) {
			const parent = node.parentNode?.nodeName.toLowerCase();
			if (parent === "script" || parent === "style") return true;
		}
		if (node instanceof Element) {
			for (const attr of Array.from(node.attributes)) {
				if (!attr.value.includes(SENTINEL)) continue;
				if (attr.name.startsWith("on") || attr.name === "srcdoc") return true;
			}
		}
	}
	return false;
}

describe("aurora > browser > the scanner against Chromium's tokenizer", () => {
	it("refuses the shapes it used to read as text", () => {
		const js = "\nalert(document.domain)";
		expect(
			codeOf(() => renderToString(html`<!--> <script>${js}</script>`)),
		).toBe("E_AURORA_SLOT_IN_RAW_TEXT");
		expect(
			codeOf(() => renderToString(html`<!-- a --!> <b onclick="${js}">x</b>`)),
		).toBe("E_AURORA_SLOT_IN_EVENT_ATTRIBUTE");
		expect(
			codeOf(() => renderToString(html`<!---> <iframe srcdoc="${js}">`)),
		).toBe("E_AURORA_SLOT_IN_SRCDOC");
		expect(
			codeOf(() => renderToString(html`<!x a="> <script>${js}</script> ">`)),
		).toBe("E_AURORA_SLOT_IN_RAW_TEXT");
		expect(
			codeOf(() =>
				renderToString(html`<p>a < b=" <script>${js}</script>"</p>`),
			),
		).toBe("E_AURORA_SLOT_IN_RAW_TEXT");
		expect(
			codeOf(() =>
				renderToString(html`<!-- ${"x"} <script>${js}</script> -->`),
			),
		).toBe("E_AURORA_SLOT_IN_COMMENT");
	});

	it("hydrates a text slot after a stray `<`", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const name = signal("x");
		const make = () => html`<p>a < b ${name}</p>`;
		host.innerHTML = renderToString(make());
		hydrate(host, make);
		name("y");
		expect(host.querySelector("p")?.textContent).toBe("a < b y");
		host.remove();
	});

	it("never lets a slot it accepted land in code", () => {
		const pieces = [
			"<!--",
			"-->",
			"--!>",
			"<!-->",
			"<!--->",
			"-",
			"<!x ",
			"<?",
			"</ ",
			"</>",
			"<",
			"< ",
			' a="',
			"'",
			'"',
			">",
			"<b ",
			"<script>",
			"</script>",
			' onclick="',
			' srcdoc="',
			"<svg>",
			"</svg>",
			"<![CDATA[",
			"]]>",
			"<!DOCTYPE ",
		];
		let state = 1109;
		const random = (): number => {
			state = (state * 1103515245 + 12345) % 2147483648;
			return state / 2147483648;
		};
		const pick = (): string =>
			pieces[Math.floor(random() * pieces.length)] ?? "";
		const escaped: string[] = [];
		for (let run = 0; run < 4000; run++) {
			let before = "";
			const length = 1 + Math.floor(random() * 6);
			for (let k = 0; k < length; k++) before += pick();
			const after = pick() + pick();
			const strings = Object.assign([before, after], { raw: [before, after] });
			let markup: string;
			try {
				markup = renderToString(html(strings, SENTINEL));
			} catch {
				continue;
			}
			if (landedInCode(markup)) escaped.push(`${before}\${}${after}`);
		}
		expect(escaped).toEqual([]);
	});
});
