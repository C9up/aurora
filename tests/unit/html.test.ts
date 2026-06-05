import { describe, expect, it } from "vitest";
import { getTemplate, html, isTemplateResult } from "../../src/html.js";

describe("aurora > html > tag", () => {
	it("returns a TemplateResult with strings + values", () => {
		const result = html`<div>${1}</div>`;
		expect(isTemplateResult(result)).toBe(true);
		expect(result.values).toEqual([1]);
	});

	it("brand survives across separate call sites", () => {
		const a = html`<a></a>`;
		const b = html`<b></b>`;
		expect(isTemplateResult(a)).toBe(true);
		expect(isTemplateResult(b)).toBe(true);
	});

	it("isTemplateResult rejects look-alikes", () => {
		expect(isTemplateResult({ strings: [], values: [] })).toBe(false);
		expect(isTemplateResult("html`<a>`")).toBe(false);
		expect(isTemplateResult(null)).toBe(false);
	});
});

describe("aurora > html > template cache", () => {
	it("returns the same compiled template for identical call sites", () => {
		const make = () => html`<p>${0}</p>`;
		const a = getTemplate(make().strings);
		const b = getTemplate(make().strings);
		expect(a).toBe(b);
	});

	it("compiles distinct templates for distinct source positions", () => {
		const a = getTemplate(html`<p>${0}</p>`.strings);
		const b = getTemplate(html`<span>${0}</span>`.strings);
		expect(a).not.toBe(b);
	});
});

describe("aurora > html > slot detection (text region)", () => {
	it("maps a child text interpolation to a text slot", () => {
		const tpl = getTemplate(html`<div>${0}</div>`.strings);
		expect(tpl.slots).toHaveLength(1);
		expect(tpl.slots[0].kind).toBe("text");
	});

	it("maps interleaved text + values to multiple text slots", () => {
		const tpl = getTemplate(html`<p>a ${1} b ${2} c</p>`.strings);
		expect(tpl.slots).toHaveLength(2);
		expect(tpl.slots.every((s) => s.kind === "text")).toBe(true);
	});

	it("removes attribute-source markers from the rendered template", () => {
		const tpl = getTemplate(html`<a href="${"x"}">link</a>`.strings);
		// Attr value should NOT contain the raw placeholder anymore — it
		// was extracted into a slot descriptor and stripped from the DOM.
		const fragment = tpl.element.content.cloneNode(true) as DocumentFragment;
		const a = fragment.querySelector("a");
		expect(a).not.toBeNull();
		expect(a?.getAttribute("href") ?? "").not.toContain("__aurora");
	});
});

describe("aurora > html > slot detection (attribute / event / prop)", () => {
	it("captures attr slot with name", () => {
		const tpl = getTemplate(html`<input class="${"x"}" />`.strings);
		expect(tpl.slots).toHaveLength(1);
		const slot = tpl.slots[0];
		if (slot.kind !== "attr") throw new Error("expected attr slot");
		expect(slot.name).toBe("class");
	});

	it("captures boolean-attr slot for ?attr", () => {
		const tpl = getTemplate(
			html`<button ?disabled="${true}">x</button>`.strings,
		);
		expect(tpl.slots).toHaveLength(1);
		const slot = tpl.slots[0];
		expect(slot.kind).toBe("boolean-attr");
		if (slot.kind === "boolean-attr") expect(slot.name).toBe("disabled");
	});

	it("captures prop slot for .prop", () => {
		const tpl = getTemplate(html`<input .value="${"x"}" />`.strings);
		const slot = tpl.slots[0];
		expect(slot.kind).toBe("prop");
		if (slot.kind === "prop") expect(slot.name).toBe("value");
	});

	it("captures event slot for @event", () => {
		const tpl = getTemplate(
			html`<button @click="${() => {}}">x</button>`.strings,
		);
		const slot = tpl.slots[0];
		expect(slot.kind).toBe("event");
		if (slot.kind === "event") expect(slot.event).toBe("click");
	});

	it("captures multiple slots in a single attribute with static parts", () => {
		const tpl = getTemplate(
			html`<div class="a ${"foo"} b ${"bar"} c">x</div>`.strings,
		);
		expect(tpl.slots).toHaveLength(2);
		const [s1, s2] = tpl.slots;
		if (s1.kind !== "attr" || s2.kind !== "attr") {
			throw new Error("expected attr slots");
		}
		expect(s1.staticParts).toBe(s2.staticParts);
		expect(s1.staticPartIndex).toBe(0);
		expect(s2.staticPartIndex).toBe(1);
		expect(s1.staticParts).toEqual(["a ", " b ", " c"]);
	});
});

describe("aurora > html > paths point to the right node", () => {
	it("attr slot path resolves to its element", () => {
		const tpl = getTemplate(html`<a class="${"x"}">y</a>`.strings);
		const fragment = tpl.element.content.cloneNode(true) as DocumentFragment;
		const slot = tpl.slots[0];
		if (slot.kind !== "attr") throw new Error("attr expected");
		let node: Node = fragment;
		for (const i of slot.path) node = node.childNodes[i];
		expect((node as Element).tagName.toLowerCase()).toBe("a");
	});

	it("text slot path resolves to the comment marker", () => {
		const tpl = getTemplate(html`<p>x ${"y"} z</p>`.strings);
		const fragment = tpl.element.content.cloneNode(true) as DocumentFragment;
		const slot = tpl.slots[0];
		let node: Node = fragment;
		for (const i of slot.path) node = node.childNodes[i];
		expect(node.nodeType).toBe(8 /* COMMENT_NODE */);
	});
});
