import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	each,
	html,
	hydrate,
	render,
	renderToString,
	signal,
} from "../../src/index.js";

/**
 * A lazy list in Chromium: only the rows in view exist, the spacers keep the
 * scroll range, a corrected estimate does not move what is on screen, and a
 * conversation starts and stays at its end.
 */

type Row = { id: number; tall: boolean };

let container: HTMLElement;
let dispose: () => void = () => {};
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	dispose();
	dispose = () => {};
	warnSpy.mockRestore();
	container.remove();
});

const frame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Let the list measure and settle: a few frames. */
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await frame();
}

function rows(count: number, tall = () => false): Row[] {
	return Array.from({ length: count }, (_, id) => ({ id, tall: tall() }));
}

function list(
	items: () => readonly Row[],
	options: {
		estimate?: number;
		from?: "start" | "end";
		/** Without the browser's scroll anchoring, as on Safari: the list's own must hold. */
		noAnchoring?: boolean;
	} = {},
) {
	const anchoring = options.noAnchoring ? ";overflow-anchor:none" : "";
	return html`<div class="scroller" style=${`height:400px;overflow-y:auto${anchoring}`}>
		<div class="rows" style="display:flex;flex-direction:column">${each(
			items,
			(row) => row.id,
			(row, index) =>
				html`<div class="row" data-id=${() => row().id} style=${() =>
					`height:${row().tall ? 100 : 40}px`}>${() => `#${index()}`}</div>`,
			{
				lazy: {
					estimate: options.estimate ?? 40,
					overscan: 200,
					from: options.from,
				},
			},
		)}</div>
	</div>`;
}

const scroller = () => {
	const el = container.querySelector(".scroller");
	if (!(el instanceof HTMLElement)) throw new Error("no scroller");
	return el;
};
const shownIds = () =>
	Array.from(container.querySelectorAll(".row")).map((el) =>
		Number(el.getAttribute("data-id")),
	);

/** The row under the scroller's top edge, and how far below that edge it starts. */
function topRow(): { id: number; offset: number } {
	const box = scroller().getBoundingClientRect();
	for (const el of Array.from(container.querySelectorAll(".row"))) {
		const rect = el.getBoundingClientRect();
		if (rect.bottom > box.top)
			return {
				id: Number(el.getAttribute("data-id")),
				offset: rect.top - box.top,
			};
	}
	throw new Error("no row in view");
}

describe("aurora > browser > each({ lazy })", () => {
	it("builds only the rows in view, and the spacers keep the scroll range", async () => {
		const items = signal(rows(10_000));
		dispose = render(list(items), container);
		await settle();
		// 400 px of rows of 40 plus 200 px each side: about 20 rows.
		expect(shownIds().length).toBeLessThanOrEqual(25);
		expect(shownIds()[0]).toBe(0);
		expect(scroller().scrollHeight).toBe(10_000 * 40);

		scroller().scrollTop = 200_000;
		await settle();
		const ids = shownIds();
		expect(ids.length).toBeLessThanOrEqual(25);
		expect(ids).toContain(5000);
		expect(topRow()).toEqual({ id: 5000, offset: 0 });
		expect(scroller().scrollHeight).toBe(10_000 * 40);
	});

	it("mounts 10 000 rows in the time of 100: what the screen shows", async () => {
		/** Best of three mounts, unmounted each time. */
		const mount = (count: number) => {
			let best = Number.POSITIVE_INFINITY;
			for (let run = 0; run < 3; run++) {
				const items = signal(rows(count));
				const t0 = performance.now();
				const end = render(list(items), container);
				best = Math.min(best, performance.now() - t0);
				end();
			}
			return best;
		};
		mount(100);
		const few = mount(100);
		const many = mount(10_000);
		// Both build one window; the 10 000 keys are the only extra.
		expect(many).toBeLessThan(few * 3 + 15);
	});

	it.each([
		["with the browser's scroll anchoring", false],
		["without it, as on Safari", true],
	])(
		"keeps what is on screen in place when measures correct the estimate (%s)",
		async (_, noAnchoring) => {
			// Rows are 100 px, estimated 40: every row measured moves the ones below.
			const items = signal(rows(2000, () => true));
			dispose = render(list(items, { estimate: 40, noAnchoring }), container);
			await settle();
			scroller().scrollTop = 30_000;
			await settle();
			const before = topRow();
			// Scrolling up through rows never measured: each correction above.
			for (let i = 0; i < 5; i++) {
				scroller().scrollTop -= 300;
				await settle();
			}
			const after = topRow();
			// 1500 px up through 100 px rows: 15 rows up, wherever the estimates said.
			expect(before.id - after.id).toBeGreaterThanOrEqual(14);
			expect(before.id - after.id).toBeLessThanOrEqual(16);
			// Once measured, the range above is real: scrolling back lands on the same row.
			scroller().scrollTop += 1500;
			await settle();
			expect(topRow().id).toBe(before.id);
		},
		// A dozen settles of a few frames each: slow when the machine is busy.
		30_000,
	);

	it("starts a conversation at its end and stays there as messages arrive", async () => {
		const items = signal(rows(5000));
		dispose = render(list(items, { from: "end" }), container);
		await settle();
		const box = scroller();
		expect(box.scrollTop + box.clientHeight).toBeGreaterThanOrEqual(
			box.scrollHeight - 2,
		);
		expect(shownIds()).toContain(4999);

		items((all) => [...all, { id: 5000, tall: false }]);
		await settle();
		expect(shownIds()).toContain(5000);
		expect(box.scrollTop + box.clientHeight).toBeGreaterThanOrEqual(
			box.scrollHeight - 2,
		);

		// Scrolled up to read: a new message does not pull the reader down.
		box.scrollTop -= 2000;
		await settle();
		const reading = topRow();
		items((all) => [...all, { id: 5001, tall: false }]);
		await settle();
		expect(topRow()).toEqual(reading);
	});

	it("adopts the server's first window and spacers, then scrolls lazily", async () => {
		const items = signal(rows(3000));
		const factory = () => list(items);
		container.innerHTML = renderToString(factory());
		const serverRow = container.querySelector(".row");
		const spacer = container.querySelector('[data-aurora-lazy="after"]');
		dispose = hydrate(container, factory);
		expect(
			warnSpy.mock.calls.filter((c: unknown[]) =>
				String(c[0]).includes("[aurora]"),
			),
		).toEqual([]);
		await settle();
		// The server's nodes are kept: the first row and the spacer are the same.
		expect(container.querySelector(".row")).toBe(serverRow);
		expect(container.querySelector('[data-aurora-lazy="after"]')).toBe(spacer);
		expect(scroller().scrollHeight).toBe(3000 * 40);

		scroller().scrollTop = 60_000;
		await settle();
		expect(shownIds()).toContain(1500);
		expect(shownIds().length).toBeLessThanOrEqual(25);
	});
});
