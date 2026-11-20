import { describe, expect, it } from "vitest";
import { AuroraError, each, html, renderToString } from "../../src/index.js";
import { firstWindow, LazyLayout } from "../../src/lazy.js";

const settings = { estimate: 50, overscan: 100, from: "start" as const };
const keys = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("lazy window", () => {
	it("starts with the rows a first viewport and its margin take", () => {
		// (1000 + 100) / 50 = 22 rows.
		expect(firstWindow(10_000, settings)).toEqual([0, 22]);
		expect(firstWindow(10_000, { ...settings, from: "end" })).toEqual([
			9978, 10_000,
		]);
		expect(firstWindow(5, settings)).toEqual([0, 5]);
	});

	it("picks the rows intersecting the viewport plus the overscan", () => {
		const layout = new LazyLayout(settings);
		// Rows of 50: the span 1000..1400 widened to 900..1500 → rows 18..29.
		const w = layout.window(keys(100), { kind: "span", from: 1000, to: 1400 });
		expect(w).toEqual({ start: 18, end: 30, before: 900, after: 3500 });
	});

	it("uses measured heights where it has them", () => {
		const layout = new LazyLayout(settings);
		expect(layout.measure(0, 200)).toBe(true);
		expect(layout.measure(0, 200)).toBe(false);
		const w = layout.window(keys(100), { kind: "span", from: 300, to: 400 });
		// Row 0 takes 200: rows 1.. start at 200, so 200..500 holds rows 1..6.
		expect(w.start).toBe(1);
		expect(w.before).toBe(200);
	});

	it("covers the viewport from the end when pinned there", () => {
		const layout = new LazyLayout(settings);
		const w = layout.window(keys(100), { kind: "end", height: 400 });
		// 400 + 100 of rows of 50: the last 10.
		expect(w).toEqual({ start: 90, end: 100, before: 4500, after: 0 });
	});

	it("builds nothing for a viewport past the list", () => {
		const layout = new LazyLayout(settings);
		const w = layout.window(keys(10), { kind: "span", from: 5000, to: 5400 });
		expect(w).toEqual({ start: 10, end: 10, before: 500, after: 0 });
	});

	it("finds the same window as walking every row, on random lists", () => {
		// The walk the running sums replace, kept here as the reference.
		const walk = (
			heights: number[],
			view: { from: number; to: number } | { end: number },
			overscan: number,
		) => {
			const count = heights.length;
			const total = heights.reduce((a, b) => a + b, 0);
			let start = count;
			let end = count;
			if ("end" in view) {
				let covered = 0;
				start = count;
				while (start > 0 && covered < view.end + overscan) {
					start--;
					covered += heights[start] ?? 0;
				}
			} else {
				let y = 0;
				for (let i = 0; i < count; i++) {
					const h = heights[i] ?? 0;
					if (start === count && y + h > view.from - overscan) start = i;
					if (end === count && y >= view.to + overscan) end = i;
					y += h;
				}
				if (start > end) start = end;
			}
			const before = heights.slice(0, start).reduce((a, b) => a + b, 0);
			const after = total - heights.slice(0, end).reduce((a, b) => a + b, 0);
			return { start, end, before, after };
		};
		let seed = 1;
		const random = () => {
			seed = (seed * 16807) % 2147483647;
			return seed / 2147483647;
		};
		for (let run = 0; run < 2000; run++) {
			const count = Math.floor(random() * 60);
			const overscan = Math.floor(random() * 120);
			const layout = new LazyLayout({ estimate: 40, overscan, from: "start" });
			const heights = Array.from({ length: count }, (_, i) => {
				if (random() < 0.5) return 40;
				const h = Math.floor(random() * 120);
				layout.measure(i, h);
				return h;
			});
			const ids = keys(count);
			const from = Math.floor(random() * 3000) - 200;
			const span = { from, to: from + Math.floor(random() * 600) };
			expect(layout.window(ids, { kind: "span", ...span })).toEqual(
				walk(heights, span, overscan),
			);
			const height = Math.floor(random() * 800);
			expect(layout.window(ids, { kind: "end", height })).toEqual(
				walk(heights, { end: height }, overscan),
			);
		}
	});

	it("forgets the heights of keys that left", () => {
		const layout = new LazyLayout(settings);
		layout.measure("a", 10);
		layout.measure("b", 10);
		layout.keep(["b"]);
		expect(layout.heightOf("a")).toBe(50);
		expect(layout.heightOf("b")).toBe(10);
	});
});

describe("each({ lazy }) on the server", () => {
	const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }));

	it("renders the first window between two spacers sized by the estimate", () => {
		const out = renderToString(
			html`<div>${each(
				rows,
				(row) => row.id,
				(row, index) => html`<p>${() => `${index()}:${row().id}`}</p>`,
				{ lazy: { estimate: 50, overscan: 100 } },
			)}</div>`,
		);
		expect(out.match(/<p>/g)).toHaveLength(22);
		expect(out).toContain("<div data-aurora-lazy=before");
		expect(out).toContain("display:none");
		expect(out).toContain(`height:${(1000 - 22) * 50}px`);
		expect(out).toContain("<!--$-->21:21<!--/$-->");
	});

	it("starts from the end for a conversation, with the rows' real indexes", () => {
		const out = renderToString(
			html`<div>${each(
				rows,
				(row) => row.id,
				(row, index) => html`<p>${() => `${index()}:${row().id}`}</p>`,
				{ lazy: { estimate: 50, overscan: 100, from: "end" } },
			)}</div>`,
		);
		expect(out).toContain(`height:${(1000 - 22) * 50}px`);
		expect(out).toContain("<!--$-->978:978<!--/$-->");
		expect(out).toContain("<!--$-->999:999<!--/$-->");
		expect(out).not.toContain("<!--$-->977:977<!--/$-->");
	});

	it("refuses an estimate or an overscan that is not a length", () => {
		const code = (run: () => unknown) => {
			try {
				run();
			} catch (error) {
				return error instanceof AuroraError ? error.code : String(error);
			}
			return undefined;
		};
		const render = () => html`<p></p>`;
		expect(
			code(() => each(rows, (r) => r.id, render, { lazy: { estimate: 0 } })),
		).toBe("E_AURORA_INVALID_LAZY");
		expect(
			code(() => each(rows, (r) => r.id, render, { lazy: { overscan: -1 } })),
		).toBe("E_AURORA_INVALID_LAZY");
		expect(
			code(() =>
				each(rows, (r) => r.id, render, { lazy: { estimate: Number.NaN } }),
			),
		).toBe("E_AURORA_INVALID_LAZY");
	});
});
