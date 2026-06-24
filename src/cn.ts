/**
 * `cn` — class-name composition with Tailwind conflict resolution, reimplemented
 * from scratch with ZERO dependencies (no clsx, no tailwind-merge).
 *
 *   cn('px-2 py-1', isActive && 'bg-indigo-600', props.class)
 *   cn('px-2', 'px-4')                // → 'px-4'  (later wins within a group)
 *   cn('mr-4', 'mr-8')               // → 'mr-8'  (dedup is the whole point)
 *   cn('text-red-500', 'text-sm')     // → 'text-red-500 text-sm' (different groups)
 *   cn('hover:p-2', 'hover:p-4', 'p-1')// → 'p-1 hover:p-4' (variant-scoped)
 *
 * Two parts:
 *   1. {@link clsx} — flatten strings / numbers / arrays / objects into a class
 *      string, dropping falsy values (full clsx semantics).
 *   2. {@link twMerge} — within the SAME variant stack (`hover:`, `md:`, `!`, …),
 *      keep only the LAST class of each conflicting Tailwind group; unknown
 *      classes never conflict and are always kept, in source order.
 *
 * Targets the standard Tailwind v4 utility set. Node-free — part of aurora's
 * client runtime.
 */

// ─── clsx ───────────────────────────────────────────────────────────────────

export type ClassValue =
	| ClassValue[]
	| Record<string, unknown>
	| string
	| number
	| bigint
	| null
	| boolean
	| undefined;

function appendValue(mix: ClassValue): string {
	if (typeof mix === "string") return mix;
	if (typeof mix === "number" || typeof mix === "bigint") {
		// clsx includes any truthy number (0 / 0n are falsy → dropped).
		return mix ? String(mix) : "";
	}
	if (typeof mix !== "object" || mix === null) return "";
	if (Array.isArray(mix)) {
		let out = "";
		for (const item of mix) {
			const piece = appendValue(item);
			if (piece !== "") out = out === "" ? piece : `${out} ${piece}`;
		}
		return out;
	}
	// Plain object: include each key whose value is truthy.
	let out = "";
	for (const key in mix) {
		if (mix[key]) out = out === "" ? key : `${out} ${key}`;
	}
	return out;
}

/** clsx-equivalent: join truthy class values (strings, numbers, arrays, objects). */
export function clsx(...inputs: ClassValue[]): string {
	let out = "";
	for (const input of inputs) {
		const piece = appendValue(input);
		if (piece !== "") out = out === "" ? piece : `${out} ${piece}`;
	}
	return out;
}

// ─── validators ──────────────────────────────────────────────────────────────

const FRACTION = /^\d+\/\d+$/;
const NUMBER = /^\d+(\.\d+)?$/;
const LENGTH_UNIT =
	/^-?\d+(\.\d+)?(px|r?em|%|vh|vw|vmin|vmax|cm|mm|in|pt|pc|ex|ch|fr|deg|rad|grad|turn|s|ms|q)$/;
const TSHIRT = /^(\d+xs|xs|sm|md|lg|xl|\d+xl)$/;

const isArbitrary = (s: string): boolean => /^\[.+\]$/.test(s);
/** Arbitrary value tagged as a length/size, e.g. `[12px]`, `[length:…]`, `[3.2rem]`. */
const isArbitraryLength = (s: string): boolean =>
	/^\[(length|size|percentage):/.test(s) ||
	/^\[-?\d+(\.\d+)?(px|r?em|%|vh|vw|vmin|vmax|cm|mm|in|pt|pc|ex|ch|fr)\]$/.test(
		s,
	);
const isNumber = (s: string): boolean => NUMBER.test(s);
const isInteger = (s: string): boolean => /^\d+$/.test(s);
const isLength = (s: string): boolean =>
	s === "px" ||
	s === "full" ||
	s === "auto" ||
	NUMBER.test(s) ||
	FRACTION.test(s) ||
	LENGTH_UNIT.test(s) ||
	isArbitrary(s);
const isTshirt = (s: string): boolean => TSHIRT.test(s);
const any = (): boolean => true;

const WEIGHTS = [
	"thin",
	"extralight",
	"light",
	"normal",
	"medium",
	"semibold",
	"bold",
	"extrabold",
	"black",
];

// ─── class-group registry (Tailwind v4 standard utilities) ───────────────────

type Validator = (rest: string) => boolean;

interface GroupRule {
	/** Conflict-group id. Classes sharing an id (same variant stack) override. */
	id: string;
	/** Exact base class names that belong to this group. */
	eq?: string[];
	/** `[prefix, validator]` — base is `<prefix>-<rest>` and `validator(rest)` is true. */
	pre?: Array<[string, Validator]>;
}

/** The eight Tailwind spacing/side suffixes (mx, my, ms, me, mt, mr, mb, ml…). */
const SIDES = ["x", "y", "s", "e", "t", "r", "b", "l"] as const;

/** A spacing-style family (p, m, scroll-m, scroll-p): a base group + 8 side groups. */
function spacing(prefix: string, validate: Validator): GroupRule[] {
	return [
		{ id: prefix, pre: [[prefix, validate]] },
		...SIDES.map(
			(s): GroupRule => ({
				id: `${prefix}${s}`,
				pre: [[`${prefix}${s}`, validate]],
			}),
		),
	];
}

/** Conflicts for a spacing family: base overrides all sides; x→l,r and y→t,b. */
function spacingConflicts(prefix: string): Record<string, string[]> {
	return {
		[prefix]: SIDES.map((s) => `${prefix}${s}`),
		[`${prefix}x`]: [`${prefix}l`, `${prefix}r`],
		[`${prefix}y`]: [`${prefix}t`, `${prefix}b`],
	};
}

/**
 * ORDERED rules — first match wins, so the more specific keyword/size rules
 * (text-shadow, border-collapse, font-stretch…) MUST precede the catch-all
 * color rules (text-*, border-*, bg-*) that would otherwise swallow them.
 */
const RULES: GroupRule[] = [
	// ─ layout ─
	{ id: "aspect", pre: [["aspect", any]] },
	{ id: "container", eq: ["container"] },
	{ id: "columns", pre: [["columns", any]] },
	{ id: "break-after", pre: [["break-after", any]] },
	{ id: "break-before", pre: [["break-before", any]] },
	{ id: "break-inside", pre: [["break-inside", any]] },
	{
		id: "box-decoration",
		eq: ["box-decoration-clone", "box-decoration-slice"],
	},
	{ id: "box", eq: ["box-border", "box-content"] },
	{ id: "sr", eq: ["sr-only", "not-sr-only"] },
	{
		id: "display",
		eq: [
			"block",
			"inline-block",
			"inline",
			"flex",
			"inline-flex",
			"table",
			"inline-table",
			"table-caption",
			"table-cell",
			"table-row",
			"table-column",
			"table-column-group",
			"table-footer-group",
			"table-header-group",
			"table-row-group",
			"flow-root",
			"grid",
			"inline-grid",
			"contents",
			"list-item",
			"hidden",
		],
	},
	{
		id: "float",
		pre: [
			["float", (r) => ["right", "left", "none", "start", "end"].includes(r)],
		],
	},
	{ id: "clear", pre: [["clear", any]] },
	{ id: "isolation", eq: ["isolate", "isolation-auto"] },
	{
		id: "object-fit",
		pre: [
			[
				"object",
				(r) => ["contain", "cover", "fill", "none", "scale-down"].includes(r),
			],
		],
	},
	{ id: "object-position", pre: [["object", any]] },
	{ id: "overflow-x", pre: [["overflow-x", any]] },
	{ id: "overflow-y", pre: [["overflow-y", any]] },
	{
		id: "overflow",
		pre: [["overflow", (r) => !r.startsWith("x-") && !r.startsWith("y-")]],
	},
	{ id: "overscroll-x", pre: [["overscroll-x", any]] },
	{ id: "overscroll-y", pre: [["overscroll-y", any]] },
	{
		id: "overscroll",
		pre: [["overscroll", (r) => !r.startsWith("x-") && !r.startsWith("y-")]],
	},
	{ id: "position", eq: ["static", "fixed", "absolute", "relative", "sticky"] },
	{ id: "inset-x", pre: [["inset-x", any]] },
	{ id: "inset-y", pre: [["inset-y", any]] },
	{
		id: "inset",
		pre: [
			[
				"inset",
				(r) =>
					r !== "ring" &&
					r !== "shadow" &&
					!["x-", "y-", "ring-", "shadow-"].some((p) => r.startsWith(p)),
			],
		],
	},
	{ id: "top", pre: [["top", any]] },
	{ id: "right", pre: [["right", any]] },
	{ id: "bottom", pre: [["bottom", any]] },
	{ id: "left", pre: [["left", any]] },
	{ id: "start", pre: [["start", any]] },
	{ id: "end", pre: [["end", any]] },
	{ id: "visibility", eq: ["visible", "invisible", "collapse"] },
	{ id: "z", pre: [["z", any]] },

	// ─ flexbox / grid ─
	{ id: "basis", pre: [["basis", any]] },
	{
		id: "flex-direction",
		pre: [
			["flex", (r) => ["row", "row-reverse", "col", "col-reverse"].includes(r)],
		],
	},
	{
		id: "flex-wrap",
		pre: [["flex", (r) => ["wrap", "wrap-reverse", "nowrap"].includes(r)]],
	},
	{
		id: "flex",
		pre: [
			[
				"flex",
				(r) =>
					r === "1" ||
					r === "auto" ||
					r === "initial" ||
					r === "none" ||
					isNumber(r) ||
					isFractionOrArbitrary(r),
			],
		],
	},
	{ id: "grow", eq: ["grow"], pre: [["grow", isNumber]] },
	{ id: "shrink", eq: ["shrink"], pre: [["shrink", isNumber]] },
	{ id: "order", pre: [["order", any]] },
	{ id: "grid-cols", pre: [["grid-cols", any]] },
	{ id: "grid-rows", pre: [["grid-rows", any]] },
	{ id: "col-start-end", pre: [["col", any]] },
	{ id: "row-start-end", pre: [["row", any]] },
	{ id: "grid-flow", pre: [["grid-flow", any]] },
	{ id: "auto-cols", pre: [["auto-cols", any]] },
	{ id: "auto-rows", pre: [["auto-rows", any]] },
	{ id: "gap-x", pre: [["gap-x", isLength]] },
	{ id: "gap-y", pre: [["gap-y", isLength]] },
	{ id: "gap", pre: [["gap", isLength]] },
	{ id: "justify-items", pre: [["justify-items", any]] },
	{ id: "justify-self", pre: [["justify-self", any]] },
	{ id: "justify-content", pre: [["justify", any]] },
	{ id: "content", pre: [["content", (r) => r === "none" || isArbitrary(r)]] },
	{ id: "align-content", pre: [["content", any]] },
	{ id: "align-items", pre: [["items", any]] },
	{ id: "align-self", pre: [["self", any]] },
	{ id: "place-content", pre: [["place-content", any]] },
	{ id: "place-items", pre: [["place-items", any]] },
	{ id: "place-self", pre: [["place-self", any]] },

	// ─ spacing ─
	...spacing("p", isLength),
	...spacing("m", isLength),
	{ id: "space-x-reverse", eq: ["space-x-reverse"] },
	{ id: "space-y-reverse", eq: ["space-y-reverse"] },
	{ id: "space-x", pre: [["space-x", any]] },
	{ id: "space-y", pre: [["space-y", any]] },
	...spacing("scroll-m", isLength),
	...spacing("scroll-p", isLength),

	// ─ sizing ─
	{ id: "size", pre: [["size", isLength]] },
	{
		id: "w",
		eq: ["w-screen", "w-min", "w-max", "w-fit"],
		pre: [["w", isLength]],
	},
	{ id: "min-w", pre: [["min-w", any]] },
	{ id: "max-w", pre: [["max-w", any]] },
	{
		id: "h",
		eq: ["h-screen", "h-min", "h-max", "h-fit"],
		pre: [["h", isLength]],
	},
	{ id: "min-h", pre: [["min-h", any]] },
	{ id: "max-h", pre: [["max-h", any]] },

	// ─ typography ─
	{ id: "font-stretch", pre: [["font-stretch", any]] },
	{
		id: "font-weight",
		pre: [["font", (r) => WEIGHTS.includes(r) || isNumber(r)]],
	},
	{ id: "font-family", pre: [["font", any]] },
	{
		id: "text-shadow",
		eq: ["text-shadow"],
		pre: [
			["text-shadow", (r) => isTshirt(r) || r === "none" || isArbitrary(r)],
		],
	},
	{ id: "text-shadow-color", pre: [["text-shadow", any]] },
	{
		id: "text-align",
		pre: [
			[
				"text",
				(r) =>
					["left", "center", "right", "justify", "start", "end"].includes(r),
			],
		],
	},
	{
		id: "text-overflow",
		eq: ["truncate"],
		pre: [["text", (r) => ["ellipsis", "clip"].includes(r)]],
	},
	{
		id: "text-wrap",
		pre: [["text", (r) => ["wrap", "nowrap", "balance", "pretty"].includes(r)]],
	},
	{
		id: "font-size",
		pre: [["text", (r) => isTshirt(r) || isLength(r) || isArbitraryLength(r)]],
	},
	{ id: "text-color", pre: [["text", any]] },
	{ id: "leading", pre: [["leading", any]] },
	{ id: "tracking", pre: [["tracking", any]] },
	{ id: "line-clamp", pre: [["line-clamp", any]] },
	{
		id: "list-style-position",
		pre: [["list", (r) => ["inside", "outside"].includes(r)]],
	},
	{ id: "list-image", pre: [["list-image", any]] },
	{ id: "list-style-type", pre: [["list", any]] },
	{
		id: "text-decoration",
		eq: ["underline", "overline", "line-through", "no-underline"],
	},
	{
		id: "text-decoration-style",
		pre: [
			[
				"decoration",
				(r) => ["solid", "dashed", "dotted", "double", "wavy"].includes(r),
			],
		],
	},
	{
		id: "text-decoration-thickness",
		pre: [
			["decoration", (r) => r === "auto" || r === "from-font" || isLength(r)],
		],
	},
	{ id: "decoration-color", pre: [["decoration", any]] },
	{ id: "underline-offset", pre: [["underline-offset", any]] },
	{
		id: "text-transform",
		eq: ["uppercase", "lowercase", "capitalize", "normal-case"],
	},
	{ id: "font-style", eq: ["italic", "not-italic"] },
	{ id: "font-smoothing", eq: ["antialiased", "subpixel-antialiased"] },
	{ id: "whitespace", pre: [["whitespace", any]] },
	{
		id: "word-break",
		pre: [["break", (r) => ["normal", "words", "all", "keep"].includes(r)]],
	},
	{ id: "hyphens", pre: [["hyphens", any]] },
	{ id: "indent", pre: [["indent", any]] },
	{ id: "align", pre: [["align", any]] },

	// ─ backgrounds ─
	{
		id: "bg-attachment",
		pre: [["bg", (r) => ["fixed", "local", "scroll"].includes(r)]],
	},
	{ id: "bg-clip", pre: [["bg-clip", any]] },
	{ id: "bg-origin", pre: [["bg-origin", any]] },
	{
		id: "bg-position",
		pre: [
			[
				"bg",
				(r) =>
					[
						"bottom",
						"center",
						"left",
						"left-bottom",
						"left-top",
						"right",
						"right-bottom",
						"right-top",
						"top",
					].includes(r),
			],
		],
	},
	{
		id: "bg-repeat",
		pre: [
			[
				"bg",
				(r) => r === "repeat" || r.startsWith("repeat-") || r === "no-repeat",
			],
		],
	},
	{
		id: "bg-size",
		pre: [["bg", (r) => ["auto", "cover", "contain"].includes(r)]],
	},
	{
		id: "bg-image",
		pre: [
			[
				"bg",
				(r) =>
					r === "none" ||
					r.startsWith("gradient-") ||
					r.startsWith("linear-") ||
					r.startsWith("radial") ||
					r.startsWith("conic"),
			],
		],
	},
	{ id: "bg-blend", pre: [["bg-blend", any]] },
	{ id: "bg-color", pre: [["bg", any]] },
	{ id: "gradient-from", pre: [["from", any]] },
	{ id: "gradient-via", pre: [["via", any]] },
	{ id: "gradient-to", pre: [["to", any]] },

	// ─ borders ─
	{ id: "rounded-ss", pre: [["rounded-ss", any]] },
	{ id: "rounded-se", pre: [["rounded-se", any]] },
	{ id: "rounded-ee", pre: [["rounded-ee", any]] },
	{ id: "rounded-es", pre: [["rounded-es", any]] },
	{ id: "rounded-s", pre: [["rounded-s", any]] },
	{ id: "rounded-e", pre: [["rounded-e", any]] },
	{ id: "rounded-t", pre: [["rounded-t", any]] },
	{ id: "rounded-r", pre: [["rounded-r", any]] },
	{ id: "rounded-b", pre: [["rounded-b", any]] },
	{ id: "rounded-l", pre: [["rounded-l", any]] },
	{ id: "rounded-tl", pre: [["rounded-tl", any]] },
	{ id: "rounded-tr", pre: [["rounded-tr", any]] },
	{ id: "rounded-br", pre: [["rounded-br", any]] },
	{ id: "rounded-bl", pre: [["rounded-bl", any]] },
	{
		id: "rounded",
		eq: ["rounded"],
		pre: [
			[
				"rounded",
				(r) => isTshirt(r) || r === "none" || r === "full" || isArbitrary(r),
			],
		],
	},
	{ id: "border-collapse", eq: ["border-collapse", "border-separate"] },
	{ id: "border-spacing-x", pre: [["border-spacing-x", any]] },
	{ id: "border-spacing-y", pre: [["border-spacing-y", any]] },
	{
		id: "border-spacing",
		pre: [
			["border-spacing", (r) => !r.startsWith("x-") && !r.startsWith("y-")],
		],
	},
	{
		id: "border-style",
		pre: [
			[
				"border",
				(r) =>
					["solid", "dashed", "dotted", "double", "hidden", "none"].includes(r),
			],
		],
	},
	{
		id: "border-w-x",
		pre: [
			[
				"border-x",
				(r) => r === "" || isInteger(r) || r === "px" || isArbitrary(r),
			],
		],
	},
	{
		id: "border-w-y",
		pre: [
			[
				"border-y",
				(r) => r === "" || isInteger(r) || r === "px" || isArbitrary(r),
			],
		],
	},
	{
		id: "border-w-t",
		pre: [
			[
				"border-t",
				(r) => r === "" || isInteger(r) || r === "px" || isArbitrary(r),
			],
		],
	},
	{
		id: "border-w-r",
		pre: [
			[
				"border-r",
				(r) => r === "" || isInteger(r) || r === "px" || isArbitrary(r),
			],
		],
	},
	{
		id: "border-w-b",
		pre: [
			[
				"border-b",
				(r) => r === "" || isInteger(r) || r === "px" || isArbitrary(r),
			],
		],
	},
	{
		id: "border-w-l",
		pre: [
			[
				"border-l",
				(r) => r === "" || isInteger(r) || r === "px" || isArbitrary(r),
			],
		],
	},
	{
		id: "border-w",
		eq: ["border"],
		pre: [["border", (r) => isInteger(r) || r === "px" || isArbitrary(r)]],
	},
	{ id: "border-color-x", pre: [["border-x", any]] },
	{ id: "border-color-y", pre: [["border-y", any]] },
	{ id: "border-color-t", pre: [["border-t", any]] },
	{ id: "border-color-r", pre: [["border-r", any]] },
	{ id: "border-color-b", pre: [["border-b", any]] },
	{ id: "border-color-l", pre: [["border-l", any]] },
	{ id: "border-color", pre: [["border", any]] },
	{ id: "divide-x-reverse", eq: ["divide-x-reverse"] },
	{ id: "divide-y-reverse", eq: ["divide-y-reverse"] },
	{ id: "divide-x", pre: [["divide-x", any]] },
	{ id: "divide-y", pre: [["divide-y", any]] },
	{
		id: "divide-style",
		pre: [
			[
				"divide",
				(r) => ["solid", "dashed", "dotted", "double", "none"].includes(r),
			],
		],
	},
	{ id: "divide-color", pre: [["divide", any]] },
	{
		id: "outline-style",
		eq: ["outline", "outline-none"],
		pre: [["outline", (r) => ["dashed", "dotted", "double"].includes(r)]],
	},
	{ id: "outline-offset", pre: [["outline-offset", any]] },
	{
		id: "outline-w",
		pre: [["outline", (r) => isInteger(r) || isArbitrary(r)]],
	},
	{ id: "outline-color", pre: [["outline", any]] },
	{
		id: "inset-ring-w",
		eq: ["inset-ring"],
		pre: [["inset-ring", (r) => isInteger(r) || isArbitrary(r)]],
	},
	{ id: "inset-ring-color", pre: [["inset-ring", any]] },
	{
		id: "ring-w",
		eq: ["ring"],
		pre: [["ring", (r) => isInteger(r) || r === "inset" || isArbitrary(r)]],
	},
	{
		id: "ring-offset-w",
		pre: [["ring-offset", (r) => isInteger(r) || isArbitrary(r)]],
	},
	{ id: "ring-offset-color", pre: [["ring-offset", any]] },
	{ id: "ring-color", pre: [["ring", any]] },

	// ─ effects ─
	{
		id: "shadow",
		eq: ["shadow"],
		pre: [
			[
				"shadow",
				(r) => isTshirt(r) || r === "none" || r === "inner" || isArbitrary(r),
			],
		],
	},
	{ id: "shadow-color", pre: [["shadow", any]] },
	{
		id: "inset-shadow",
		eq: ["inset-shadow"],
		pre: [
			["inset-shadow", (r) => isTshirt(r) || r === "none" || isArbitrary(r)],
		],
	},
	{ id: "inset-shadow-color", pre: [["inset-shadow", any]] },
	{ id: "opacity", pre: [["opacity", any]] },
	{ id: "mix-blend", pre: [["mix-blend", any]] },

	// ─ filters ─
	{ id: "filter", eq: ["filter", "filter-none"] },
	{ id: "blur", eq: ["blur"], pre: [["blur", any]] },
	{ id: "brightness", pre: [["brightness", any]] },
	{ id: "contrast", pre: [["contrast", any]] },
	{
		id: "drop-shadow",
		eq: ["drop-shadow"],
		pre: [
			["drop-shadow", (r) => isTshirt(r) || r === "none" || isArbitrary(r)],
		],
	},
	{ id: "drop-shadow-color", pre: [["drop-shadow", any]] },
	{ id: "grayscale", eq: ["grayscale"], pre: [["grayscale", any]] },
	{ id: "hue-rotate", pre: [["hue-rotate", any]] },
	{ id: "invert", eq: ["invert"], pre: [["invert", any]] },
	{ id: "saturate", pre: [["saturate", any]] },
	{ id: "sepia", eq: ["sepia"], pre: [["sepia", any]] },
	{ id: "backdrop-filter", eq: ["backdrop-filter", "backdrop-filter-none"] },
	{ id: "backdrop-blur", eq: ["backdrop-blur"], pre: [["backdrop-blur", any]] },
	{ id: "backdrop-brightness", pre: [["backdrop-brightness", any]] },
	{ id: "backdrop-contrast", pre: [["backdrop-contrast", any]] },
	{
		id: "backdrop-grayscale",
		eq: ["backdrop-grayscale"],
		pre: [["backdrop-grayscale", any]],
	},
	{ id: "backdrop-hue-rotate", pre: [["backdrop-hue-rotate", any]] },
	{
		id: "backdrop-invert",
		eq: ["backdrop-invert"],
		pre: [["backdrop-invert", any]],
	},
	{ id: "backdrop-opacity", pre: [["backdrop-opacity", any]] },
	{ id: "backdrop-saturate", pre: [["backdrop-saturate", any]] },
	{
		id: "backdrop-sepia",
		eq: ["backdrop-sepia"],
		pre: [["backdrop-sepia", any]],
	},

	// ─ tables ─
	{
		id: "table-layout",
		pre: [["table", (r) => ["auto", "fixed"].includes(r)]],
	},
	{ id: "caption", pre: [["caption", any]] },

	// ─ transitions / animation ─
	{ id: "transition", eq: ["transition"], pre: [["transition", any]] },
	{ id: "duration", pre: [["duration", any]] },
	{ id: "ease", pre: [["ease", any]] },
	{ id: "delay", pre: [["delay", any]] },
	{ id: "animate", pre: [["animate", any]] },

	// ─ transforms ─
	{
		id: "transform",
		eq: ["transform", "transform-none", "transform-gpu", "transform-cpu"],
	},
	{ id: "transform-origin", pre: [["origin", any]] },
	{ id: "perspective-origin", pre: [["perspective-origin", any]] },
	{ id: "perspective", pre: [["perspective", any]] },
	{ id: "backface", pre: [["backface", any]] },
	{ id: "scale-x", pre: [["scale-x", any]] },
	{ id: "scale-y", pre: [["scale-y", any]] },
	{ id: "scale-z", pre: [["scale-z", any]] },
	{ id: "scale", pre: [["scale", any]] },
	{ id: "rotate-x", pre: [["rotate-x", any]] },
	{ id: "rotate-y", pre: [["rotate-y", any]] },
	{ id: "rotate-z", pre: [["rotate-z", any]] },
	{ id: "rotate", pre: [["rotate", any]] },
	{ id: "translate-x", pre: [["translate-x", any]] },
	{ id: "translate-y", pre: [["translate-y", any]] },
	{ id: "translate-z", pre: [["translate-z", any]] },
	{ id: "translate", pre: [["translate", any]] },
	{ id: "skew-x", pre: [["skew-x", any]] },
	{ id: "skew-y", pre: [["skew-y", any]] },
	{ id: "skew", pre: [["skew", any]] },

	// ─ interactivity ─
	{ id: "accent", pre: [["accent", any]] },
	{ id: "appearance", pre: [["appearance", any]] },
	{ id: "caret", pre: [["caret", any]] },
	{ id: "color-scheme", pre: [["scheme", any]] },
	{ id: "cursor", pre: [["cursor", any]] },
	{ id: "field-sizing", pre: [["field-sizing", any]] },
	{ id: "pointer-events", pre: [["pointer-events", any]] },
	{ id: "resize", eq: ["resize", "resize-none", "resize-x", "resize-y"] },
	{
		id: "scroll-behavior",
		pre: [["scroll", (r) => ["auto", "smooth"].includes(r)]],
	},
	{
		id: "snap-align",
		pre: [
			["snap", (r) => ["start", "end", "center", "align-none"].includes(r)],
		],
	},
	{ id: "snap-stop", pre: [["snap", (r) => ["normal", "always"].includes(r)]] },
	{
		id: "snap-strictness",
		pre: [["snap", (r) => ["mandatory", "proximity"].includes(r)]],
	},
	{
		id: "snap-type",
		pre: [["snap", (r) => ["none", "x", "y", "both"].includes(r)]],
	},
	{ id: "select", pre: [["select", any]] },
	{ id: "touch", pre: [["touch", any]] },
	{ id: "user-select", pre: [["user-select", any]] },
	{ id: "will-change", pre: [["will-change", any]] },

	// ─ svg ─
	{ id: "fill", pre: [["fill", any]] },
	{
		id: "stroke-w",
		pre: [["stroke", (r) => isInteger(r) || isArbitraryLength(r)]],
	},
	{ id: "stroke", pre: [["stroke", any]] },

	// ─ accessibility ─
	{ id: "forced-color-adjust", pre: [["forced-color-adjust", any]] },

	// ─ masking (Tailwind v4) ─
	{ id: "mask-type", pre: [["mask-type", any]] },
	{ id: "mask-clip", pre: [["mask-clip", any]] },
	{ id: "mask-origin", pre: [["mask-origin", any]] },
	{
		id: "mask-mode",
		pre: [["mask", (r) => ["alpha", "luminance", "match"].includes(r)]],
	},
	{
		id: "mask-composite",
		pre: [
			["mask", (r) => ["add", "subtract", "intersect", "exclude"].includes(r)],
		],
	},
	{
		id: "mask-repeat",
		pre: [
			[
				"mask",
				(r) => r === "repeat" || r.startsWith("repeat-") || r === "no-repeat",
			],
		],
	},
	{
		id: "mask-size",
		pre: [["mask", (r) => ["auto", "cover", "contain"].includes(r)]],
	},
	{ id: "mask-image", pre: [["mask", (r) => r === "none" || isArbitrary(r)]] },
];

/** flex shorthand can take a fraction (`flex-1/2`) or an arbitrary value. */
function isFractionOrArbitrary(s: string): boolean {
	return FRACTION.test(s) || isArbitrary(s);
}

/**
 * Groups that a kept class additionally overrides — e.g. `p-4` overrides every
 * `px/py/pt/…`, and `inset-0` overrides `top/left/…`. Keyed group → groups it
 * supersedes. Resolution marks these as claimed so an EARLIER such class drops.
 */
const CONFLICTS: Record<string, string[]> = {
	overflow: ["overflow-x", "overflow-y"],
	overscroll: ["overscroll-x", "overscroll-y"],
	inset: [
		"inset-x",
		"inset-y",
		"top",
		"right",
		"bottom",
		"left",
		"start",
		"end",
	],
	"inset-x": ["right", "left"],
	"inset-y": ["top", "bottom"],
	...spacingConflicts("p"),
	...spacingConflicts("m"),
	...spacingConflicts("scroll-m"),
	...spacingConflicts("scroll-p"),
	gap: ["gap-x", "gap-y"],
	size: ["w", "h"],
	rounded: [
		"rounded-ss",
		"rounded-se",
		"rounded-ee",
		"rounded-es",
		"rounded-s",
		"rounded-e",
		"rounded-t",
		"rounded-r",
		"rounded-b",
		"rounded-l",
		"rounded-tl",
		"rounded-tr",
		"rounded-br",
		"rounded-bl",
	],
	"rounded-s": ["rounded-ss", "rounded-es"],
	"rounded-e": ["rounded-se", "rounded-ee"],
	"rounded-t": ["rounded-tl", "rounded-tr"],
	"rounded-r": ["rounded-tr", "rounded-br"],
	"rounded-b": ["rounded-br", "rounded-bl"],
	"rounded-l": ["rounded-tl", "rounded-bl"],
	"border-w": [
		"border-w-x",
		"border-w-y",
		"border-w-t",
		"border-w-r",
		"border-w-b",
		"border-w-l",
	],
	"border-w-x": ["border-w-l", "border-w-r"],
	"border-w-y": ["border-w-t", "border-w-b"],
	"border-color": [
		"border-color-x",
		"border-color-y",
		"border-color-t",
		"border-color-r",
		"border-color-b",
		"border-color-l",
	],
	"border-color-x": ["border-color-l", "border-color-r"],
	"border-color-y": ["border-color-t", "border-color-b"],
	"border-spacing": ["border-spacing-x", "border-spacing-y"],
	scale: ["scale-x", "scale-y", "scale-z"],
	translate: ["translate-x", "translate-y", "translate-z"],
	skew: ["skew-x", "skew-y"],
};

// ─── parser ──────────────────────────────────────────────────────────────────

interface Parsed {
	className: string;
	/** Sorted variant stack + important flag — the conflict SCOPE key. */
	scope: string;
	/** Conflict-group id, or null for unknown classes (never conflict). */
	groupId: string | null;
}

/** Split on a separator char at BRACKET DEPTH 0 (so `[&:hover]` / `[x:y]` stay intact). */
function splitTopLevel(s: string, sep: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let buf = "";
	for (const ch of s) {
		if (ch === "[") depth++;
		else if (ch === "]") depth = depth > 0 ? depth - 1 : 0;
		if (ch === sep && depth === 0) {
			parts.push(buf);
			buf = "";
		} else {
			buf += ch;
		}
	}
	parts.push(buf);
	return parts;
}

function resolveGroup(base: string): string | null {
	// Arbitrary property `[mask-type:luminance]` → its own per-property group.
	if (base.startsWith("[") && base.endsWith("]")) {
		const colon = base.indexOf(":");
		return colon > 0 ? `arbitrary:${base.slice(1, colon)}` : "arbitrary";
	}
	for (const rule of RULES) {
		if (rule.eq?.includes(base)) return rule.id;
		if (rule.pre) {
			for (const [prefix, validate] of rule.pre) {
				if (base === prefix && validate("")) return rule.id;
				if (
					base.startsWith(`${prefix}-`) &&
					validate(base.slice(prefix.length + 1))
				) {
					return rule.id;
				}
			}
		}
	}
	return null;
}

function parse(className: string): Parsed {
	const modifiers = splitTopLevel(className, ":");
	const last = modifiers.pop() ?? "";
	let base = last;
	let important = false;
	// Important modifier — Tailwind v4 trailing `!` (e.g. `bg-red-500!`).
	if (base.endsWith("!")) {
		important = true;
		base = base.slice(0, -1);
	}
	// Drop the opacity/postfix modifier (`/50`) at top level — not part of the group.
	base = splitTopLevel(base, "/")[0] ?? base;
	// Negative utilities share their positive group (`-mt-2` ≡ `mt-2`).
	const lookup = base.startsWith("-") ? base.slice(1) : base;
	const scope = `${modifiers.slice().sort().join(":")}${important ? "!" : ""}`;
	return { className, scope, groupId: resolveGroup(lookup) };
}

// ─── twMerge ─────────────────────────────────────────────────────────────────

/** Resolve Tailwind class conflicts: within a variant scope, the last class of each group wins. */
export function twMerge(classList: string): string {
	const classes = classList.split(/\s+/).filter(Boolean);
	const claimed = new Set<string>();
	const kept: string[] = [];
	// Walk right→left: the first time we see a (scope, group) it's the winner;
	// any earlier class of that group (or a group it supersedes) is dropped.
	for (let i = classes.length - 1; i >= 0; i--) {
		const cls = classes[i];
		if (cls === undefined) continue;
		const { scope, groupId } = parse(cls);
		if (groupId === null) {
			kept.push(cls); // unknown class — never conflicts
			continue;
		}
		const key = `${scope}|${groupId}`;
		if (claimed.has(key)) continue; // already overridden by a later class
		kept.push(cls);
		claimed.add(key);
		const supersedes = CONFLICTS[groupId];
		if (supersedes) {
			for (const g of supersedes) claimed.add(`${scope}|${g}`);
		}
	}
	return kept.reverse().join(" ");
}

// ─── cn ──────────────────────────────────────────────────────────────────────

/** Compose class values (clsx) then resolve Tailwind conflicts (twMerge). */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(...inputs));
}
