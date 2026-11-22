/**
 * Motion values on the web: the model (what a value does over time) and the
 * DOM bindings (`motion`, `scroll-y`), which hand its samples to the Web
 * Animations API — stubbed here to read what the browser would be given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html } from "../../src/html.js";
import {
	MOTION_FRAME_MS,
	MotionModel,
	MotionValue,
	motionDriver,
	readMotionStyle,
	springSamples,
} from "../../src/motion.js";
import { render } from "../../src/render.js";
import { renderToString } from "../../src/ssr.js";

interface FakeAnimation {
	cancelled: boolean;
	currentTime: number | null;
	cancel(): void;
}

interface Call {
	el: Element;
	keyframes: Keyframe[];
	options: KeyframeAnimationOptions;
	animation: FakeAnimation;
}

let calls: Call[] = [];

function stubAnimate(): void {
	calls = [];
	Reflect.set(
		Element.prototype,
		"animate",
		function animate(
			this: Element,
			keyframes: Keyframe[],
			options: KeyframeAnimationOptions,
		) {
			const animation: FakeAnimation = {
				cancelled: false,
				currentTime: null,
				cancel() {
					this.cancelled = true;
				},
			};
			calls.push({ el: this, keyframes, options, animation });
			return animation;
		},
	);
}

function live(prop: string): Call[] {
	return calls.filter(
		(c) => !c.animation.cancelled && prop in (c.keyframes[0] ?? {}),
	);
}

function model(): MotionModel {
	const driver = motionDriver();
	if (!(driver instanceof MotionModel)) throw new Error("not the model");
	return driver;
}

afterEach(() => {
	Reflect.deleteProperty(Element.prototype, "animate");
	Reflect.deleteProperty(globalThis, "ScrollTimeline");
	vi.useRealTimers();
	document.body.innerHTML = "";
});

describe("the motion model", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("plays a timing from where the value is, holds the end, and loops", () => {
		const x = new MotionValue(10);
		x.timing(20, { duration: 100 });
		const m = model();
		const start = performance.now();
		expect(m.read(x.tag, start)).toBe(10);
		expect(m.read(x.tag, start + 50)).toBeGreaterThan(10);
		expect(m.read(x.tag, start + 1000)).toBe(20);
		vi.advanceTimersByTime(1000);
		expect(m.track(x.tag)).toEqual({ kind: "static", value: 20 });

		x.timing(0, { duration: 100, loop: true, yoyo: true });
		const track = m.track(x.tag);
		expect(track.kind).toBe("samples");
		if (track.kind !== "samples") return;
		const period = track.samples.length * MOTION_FRAME_MS;
		expect(m.read(x.tag, track.start + period)).toBe(
			m.read(x.tag, track.start),
		);
		expect(m.track(x.tag).kind).toBe("samples");
	});

	it("reads sample i at start + i frames, whatever the start", () => {
		for (const offset of [0, 1000.3, 54_321.123]) {
			vi.advanceTimersByTime(offset);
			const x = new MotionValue(0);
			x.timing(300, { duration: 3000 });
			const m = model();
			const track = m.track(x.tag);
			expect(track.kind).toBe("samples");
			if (track.kind !== "samples") return;
			const read = track.samples.map((_, i) =>
				m.read(x.tag, track.start + i * MOTION_FRAME_MS),
			);
			expect(read, `start ${track.start}`).toEqual(track.samples);
			expect(read.at(-1)).toBe(300);
			x.dispose();
		}
	});

	it("settles a spring on its target, as the native host's does", () => {
		const samples = springSamples(0, 1, 260, 7, 1);
		expect(samples.at(-1)).toBe(1);
		// Under-damped: it overshoots before settling.
		expect(Math.max(...samples)).toBeGreaterThan(1);
		expect(samples.length).toBeLessThan(600);
	});

	it("stops where it is, and maps through interpolations", () => {
		const x = new MotionValue(0);
		const half = x.interpolate([0, 100], [0, 50]);
		const m = model();
		x.timing(100, { duration: 1000 });
		vi.advanceTimersByTime(500);
		x.stop();
		const stopped = m.read(x.tag);
		expect(stopped).toBeGreaterThan(0);
		expect(stopped).toBeLessThan(100);
		expect(m.read(half.tag)).toBeCloseTo(stopped / 2);
		expect(m.root(half.tag)).toBe(x.tag);
	});

	it("refuses what motion cannot drive", () => {
		const x = new MotionValue(0);
		expect(() => readMotionStyle({ rotate: x })).toThrow(/not supported/);
		expect(() => readMotionStyle({ opacity: 1 })).toThrow(/motion value/);
	});
});

describe("motion bindings in the DOM", () => {
	beforeEach(stubAnimate);

	it("hands a timing to the Web Animations API, on properties the compositor plays alone", () => {
		const x = new MotionValue(0);
		const fade = x.interpolate([0, 100], [1, 0]);
		const host = document.createElement("div");
		render(
			html`<div motion=${{ translateX: x, opacity: fade }}>box</div>`,
			host,
		);
		const box = host.querySelector("div");
		expect(box?.hasAttribute("motion")).toBe(false);

		// At rest: one held frame per property.
		expect(live("translate")[0]?.keyframes).toEqual([{ translate: "0px 0px" }]);
		// Replaced, not added onto `transform`: Chromium leaves an added
		// effect on the main thread.
		expect(live("translate")[0]?.options.composite).toBeUndefined();
		expect(live("opacity")[0]?.keyframes).toEqual([{ opacity: "1" }]);

		x.timing(100, { duration: 100, loop: true });
		const [moving] = live("translate");
		expect(moving?.options.iterations).toBe(Number.POSITIVE_INFINITY);
		expect(moving?.keyframes.at(-1)).toEqual({ translate: "100px 0px" });
		expect(moving?.options.duration).toBeCloseTo(
			(moving?.keyframes.length ?? 0) * MOTION_FRAME_MS,
		);
		// The interpolation's keyframes come from the same samples, mapped.
		expect(live("opacity")[0]?.keyframes.at(-1)).toEqual({ opacity: "0" });
		// One animation per property at a time: the held frames were cancelled.
		expect(calls.filter((c) => !c.animation.cancelled)).toHaveLength(2);
	});

	it("follows a scroll container by events where there is no scroll timeline", () => {
		const y = new MotionValue(0);
		const host = document.createElement("div");
		render(
			html`<header motion=${{ translateY: y.interpolate([0, 200], [0, -12]) }}></header>
				<div class="list" scroll-y=${y}></div>`,
			host,
		);
		const list = host.querySelector(".list");
		if (!list) throw new Error("no list");
		list.scrollTop = 100;
		list.dispatchEvent(new Event("scroll"));
		expect(live("translate")[0]?.keyframes).toEqual([
			{ translate: "0px -6px" },
		]);
	});

	it("puts the keyframes on the container's scroll timeline where there is one", () => {
		const timelines: unknown[] = [];
		Reflect.set(
			globalThis,
			"ScrollTimeline",
			class {
				constructor(options: unknown) {
					timelines.push(options);
				}
			},
		);
		const y = new MotionValue(0);
		const host = document.createElement("div");
		render(
			html`<header motion=${{ opacity: y.interpolate([0, 200], [1, 0.2]) }}></header>
				<div class="list" scroll-y=${y}></div>`,
			host,
		);
		const [scrolling] = live("opacity");
		expect(scrolling?.options.timeline).toBeDefined();
		expect(timelines[0]).toMatchObject({ axis: "block" });
	});
});

describe("motion without the Web Animations API", () => {
	it("writes the values inline", () => {
		const x = new MotionValue(4);
		const host = document.createElement("div");
		render(
			html`<div motion=${{ translateX: x, scale: x.interpolate([0, 4], [1, 2]) }}></div>`,
			host,
		);
		const box = host.querySelector("div");
		expect(box?.style.transform).toBe("translateX(4px) scale(2)");
		x.set(0);
		expect(box?.style.transform).toBe("translateX(0px) scale(1)");
	});
});

describe("motion on the server", () => {
	it("writes nothing of the bindings into the markup", () => {
		const y = new MotionValue(0);
		const markup = renderToString(
			html`<div motion=${{ opacity: y }} scroll-y=${y} class="a">x</div>`,
		);
		expect(markup).not.toContain("motion");
		expect(markup).not.toContain("scroll-y");
		expect(markup).toContain('class="a"');
	});
});
