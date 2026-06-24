import { describe, expect, it } from "vitest";
import { clsx, cn, twMerge } from "../../src/cn.js";

describe("aurora > clsx", () => {
	it("joins strings and drops falsy values", () => {
		expect(clsx("a", "b")).toBe("a b");
		expect(clsx("a", false, null, undefined, "", "b")).toBe("a b");
		expect(clsx(true && "a", false && "b")).toBe("a");
	});

	it("flattens nested arrays", () => {
		expect(clsx(["a", ["b", ["c"]]], "d")).toBe("a b c d");
		expect(clsx(["a", false, "b"])).toBe("a b");
	});

	it("includes object keys with truthy values", () => {
		expect(clsx({ a: true, b: false, c: 1, d: 0, e: "" })).toBe("a c");
		expect(clsx("base", { active: true, disabled: false })).toBe("base active");
	});

	it("handles numbers (0 is falsy)", () => {
		expect(clsx(1, 0, 2)).toBe("1 2");
	});
});

describe("aurora > twMerge — same group, last wins", () => {
	it("resolves conflicting padding", () => {
		expect(twMerge("p-2 p-4")).toBe("p-4");
		expect(twMerge("p-4 p-2")).toBe("p-2");
	});

	it("resolves conflicting colors and font-size separately", () => {
		expect(twMerge("text-red-500 text-blue-500")).toBe("text-blue-500");
		// font-size and text-color are DIFFERENT groups — both survive.
		expect(twMerge("text-sm text-red-500")).toBe("text-sm text-red-500");
		expect(twMerge("text-sm text-lg")).toBe("text-lg");
	});

	it("keeps unrelated utilities", () => {
		expect(twMerge("px-2 py-1 font-bold text-sm")).toBe(
			"px-2 py-1 font-bold text-sm",
		);
	});

	it("merges arbitrary values within a group", () => {
		expect(twMerge("p-[2px] p-[4px]")).toBe("p-[4px]");
		expect(twMerge("m-2 m-[3rem]")).toBe("m-[3rem]");
	});

	it("merges arbitrary properties by property name", () => {
		expect(twMerge("[mask-type:luminance] [mask-type:alpha]")).toBe(
			"[mask-type:alpha]",
		);
		// different arbitrary properties don't conflict
		expect(twMerge("[mask-type:alpha] [color:red]")).toBe(
			"[mask-type:alpha] [color:red]",
		);
	});

	it("treats negative utilities as the same group", () => {
		expect(twMerge("-mt-2 -mt-4")).toBe("-mt-4");
		expect(twMerge("mt-2 -mt-4")).toBe("-mt-4");
	});
});

describe("aurora > twMerge — variant scoping", () => {
	it("scopes conflicts per variant stack", () => {
		expect(twMerge("p-2 hover:p-4")).toBe("p-2 hover:p-4");
		expect(twMerge("hover:p-2 hover:p-4")).toBe("hover:p-4");
		expect(twMerge("md:p-2 p-1 md:p-4")).toBe("p-1 md:p-4");
	});

	it("is order-insensitive on the variant stack key", () => {
		expect(twMerge("md:hover:p-2 hover:md:p-4")).toBe("hover:md:p-4");
	});

	it("keeps arbitrary variants intact (colon inside brackets)", () => {
		expect(twMerge("[&:hover]:p-2 [&:hover]:p-4")).toBe("[&:hover]:p-4");
	});

	it("scopes the important modifier separately (v4 trailing !)", () => {
		expect(twMerge("p-2! p-4!")).toBe("p-4!");
		expect(twMerge("p-2 p-4!")).toBe("p-2 p-4!");
	});
});

describe("aurora > twMerge — conflicting class groups", () => {
	it("px/py override the per-side paddings, and vice-versa", () => {
		expect(twMerge("pl-2 px-4")).toBe("px-4");
		expect(twMerge("px-2 pl-4")).toBe("px-2 pl-4");
		expect(twMerge("p-2 px-4 pl-1")).toBe("p-2 px-4 pl-1");
	});

	it("inset overrides directional positions", () => {
		expect(twMerge("top-0 inset-0")).toBe("inset-0");
		expect(twMerge("inset-0 top-2")).toBe("inset-0 top-2");
	});

	it("size overrides w/h", () => {
		expect(twMerge("w-6 h-6 size-4")).toBe("size-4");
		expect(twMerge("size-4 w-6")).toBe("size-4 w-6");
	});

	it("rounded sides override corners", () => {
		expect(twMerge("rounded-tl-sm rounded-t-lg")).toBe("rounded-t-lg");
		expect(twMerge("rounded-t-lg rounded-tl-sm")).toBe(
			"rounded-t-lg rounded-tl-sm",
		);
	});

	it("border width vs border color are independent", () => {
		expect(twMerge("border-2 border-red-500")).toBe("border-2 border-red-500");
		expect(twMerge("border-2 border-4")).toBe("border-4");
		expect(twMerge("border-red-500 border-blue-500")).toBe("border-blue-500");
	});
});

describe("aurora > twMerge — unknown classes", () => {
	it("never drops classes it doesn't recognise, in source order", () => {
		expect(twMerge("foo p-2 bar p-4 baz")).toBe("foo bar p-4 baz");
		expect(twMerge("my-custom another-custom")).toBe(
			"my-custom another-custom",
		);
	});
});

describe("aurora > twMerge — dedup is the base behaviour", () => {
	it("a later value of the SAME utility replaces the earlier one (no accumulation)", () => {
		expect(twMerge("mr-4 mr-8")).toBe("mr-8");
		expect(twMerge("mt-1 mt-2 mt-3")).toBe("mt-3");
		expect(twMerge("bg-red-500 bg-green-500 bg-blue-500")).toBe("bg-blue-500");
	});
});

describe("aurora > twMerge — full v4 surface", () => {
	it("flex-basis", () => {
		expect(twMerge("basis-1/2 basis-full")).toBe("basis-full");
	});
	it("aspect-ratio / columns / line-clamp", () => {
		expect(twMerge("aspect-square aspect-video")).toBe("aspect-video");
		expect(twMerge("columns-2 columns-3")).toBe("columns-3");
		expect(twMerge("line-clamp-2 line-clamp-3")).toBe("line-clamp-3");
	});
	it("scroll-margin / scroll-padding families", () => {
		expect(twMerge("scroll-mt-2 scroll-mt-4")).toBe("scroll-mt-4");
		expect(twMerge("scroll-m-2 scroll-mt-4")).toBe("scroll-m-2 scroll-mt-4");
		expect(twMerge("scroll-mt-4 scroll-m-2")).toBe("scroll-m-2");
		expect(twMerge("scroll-p-2 scroll-px-4")).toBe("scroll-p-2 scroll-px-4");
	});
	it("font-stretch is independent of font-weight and font-family", () => {
		expect(twMerge("font-stretch-condensed font-stretch-expanded")).toBe(
			"font-stretch-expanded",
		);
		expect(twMerge("font-bold font-stretch-condensed font-sans")).toBe(
			"font-bold font-stretch-condensed font-sans",
		);
		expect(twMerge("font-sans font-mono")).toBe("font-mono");
	});
	it("text-shadow (v4) is independent of text color", () => {
		expect(twMerge("text-shadow-sm text-shadow-lg")).toBe("text-shadow-lg");
		expect(twMerge("text-shadow-sm text-red-500")).toBe(
			"text-shadow-sm text-red-500",
		);
		expect(twMerge("text-shadow-md text-shadow-red-500")).toBe(
			"text-shadow-md text-shadow-red-500",
		);
	});
	it("inset-shadow / inset-ring (v4) don't collide with inset", () => {
		expect(twMerge("inset-shadow-sm inset-shadow-lg")).toBe("inset-shadow-lg");
		expect(twMerge("inset-0 inset-shadow-sm")).toBe("inset-0 inset-shadow-sm");
		expect(twMerge("inset-ring-2 inset-ring-4")).toBe("inset-ring-4");
	});
	it("3D transforms: base axis-utilities override their per-axis variants", () => {
		expect(twMerge("translate-x-2 translate-4")).toBe("translate-4");
		expect(twMerge("scale-x-50 scale-100")).toBe("scale-100");
		expect(twMerge("rotate-45 rotate-90")).toBe("rotate-90");
		expect(twMerge("transform-gpu transform-none")).toBe("transform-none");
	});
	it("scroll-snap groups (align / type / strictness) are independent", () => {
		expect(twMerge("snap-start snap-center")).toBe("snap-center");
		expect(twMerge("snap-x snap-y")).toBe("snap-y");
		expect(twMerge("snap-start snap-mandatory")).toBe(
			"snap-start snap-mandatory",
		);
	});
	it("table utilities: border-collapse resolves (not swallowed by border-color)", () => {
		expect(twMerge("border-collapse border-separate")).toBe("border-separate");
		expect(twMerge("border-collapse border-red-500")).toBe(
			"border-collapse border-red-500",
		);
		expect(twMerge("border-spacing-2 border-spacing-4")).toBe(
			"border-spacing-4",
		);
	});
	it("content property vs align-content are distinct", () => {
		expect(twMerge("content-center content-between")).toBe("content-between");
		expect(twMerge("content-none content-center")).toBe(
			"content-none content-center",
		);
	});
	it("backdrop filters are each their own group", () => {
		expect(twMerge("backdrop-blur-sm backdrop-blur-lg")).toBe(
			"backdrop-blur-lg",
		);
		expect(twMerge("backdrop-blur-sm backdrop-brightness-50")).toBe(
			"backdrop-blur-sm backdrop-brightness-50",
		);
	});
});

describe("aurora > cn", () => {
	it("composes (clsx) then resolves Tailwind conflicts (twMerge)", () => {
		expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
		expect(cn("text-sm", true && "font-bold", false && "italic")).toBe(
			"text-sm font-bold",
		);
		expect(cn(["rounded-lg", "border"], { "bg-indigo-600": true })).toBe(
			"rounded-lg border bg-indigo-600",
		);
	});

	it("lets a later (e.g. incoming `class` prop) value override base classes", () => {
		const base = "rounded-lg border px-3 py-2 text-neutral-900";
		expect(cn(base, "px-4 text-white")).toBe(
			"rounded-lg border py-2 px-4 text-white",
		);
	});

	it("returns an empty string for no/empty input", () => {
		expect(cn()).toBe("");
		expect(cn(false, null, undefined, "")).toBe("");
	});
});
