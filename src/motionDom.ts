/**
 * `motion` and `scroll-y` in the DOM renderer.
 *
 * A bound property is one Web Animation on the element, rebuilt each time
 * its value is set, animated or stopped: the samples the model already holds
 * become keyframes, mapped through the binding's interpolations, so the
 * browser plays them on its own clock — opacity and transform on the
 * compositor, which a busy main thread does not stop. Translations and
 * scale animate the individual `translate` and `scale` properties, so a
 * `translate-*` or `scale-*` class on the same element is overridden while
 * it is bound; a `transform` (a `rotate-*`) stays and composes with them.
 *
 * A value fed by `scroll-y` follows its scroll container: through a
 * `ScrollTimeline` where the browser has one (the keyframes span the scroll
 * range, no script runs per scroll), else by setting the value on each
 * scroll event. Without the Web Animations API (an old browser, jsdom), the
 * properties are written inline, every frame while something animates.
 */

import {
	MOTION_FRAME_MS,
	MOTION_KEYS,
	type MotionKey,
	MotionModel,
	type MotionNode,
	type MotionValue,
	motionDriver,
	readMotionStyle,
} from "./motion.js";
import type { Disposer } from "./types.js";

/** The scroll container feeding a root value (`scroll-y`), per root tag. */
const scrollers = new Map<number, Element>();
/** Who re-renders when a scroller's range changes, per root tag. */
const rangeWatchers = new Map<number, Set<() => void>>();

function model(): MotionModel | undefined {
	const driver = motionDriver();
	return driver instanceof MotionModel ? driver : undefined;
}

/**
 * What a binding animates, per CSS property. Translations and scale are the
 * individual transform properties (`translate`, `scale`), which the
 * compositor plays alone — an effect composited onto `transform` with
 * `composite: 'add'` was not, and stopped with the main thread. Both
 * translations share `translate`, so they animate as one.
 */
type Group = "opacity" | "translate" | "scale" | "visibility";

const GROUP_OF: Record<MotionKey, Group> = {
	opacity: "opacity",
	translateX: "translate",
	translateY: "translate",
	scale: "scale",
	visible: "visibility",
};

type GroupValues = Partial<Record<MotionKey, number>>;

function groupFrame(group: Group, v: GroupValues): Keyframe {
	switch (group) {
		case "opacity":
			return { opacity: String(v.opacity ?? 1) };
		case "translate":
			return { translate: `${v.translateX ?? 0}px ${v.translateY ?? 0}px` };
		case "scale":
			return { scale: String(v.scale ?? 1) };
		case "visibility":
			return { visibility: (v.visible ?? 1) > 0.5 ? "visible" : "hidden" };
	}
}

/** What this module builds a scroll timeline with (Chromium, Safari 26+). */
type ScrollTimelineConstructor = new (options: {
	source: Element;
	axis: "block";
}) => AnimationTimeline;

function isScrollTimelineConstructor(
	value: unknown,
): value is ScrollTimelineConstructor {
	return typeof value === "function";
}

function scrollTimelineClass(): ScrollTimelineConstructor | undefined {
	const value: unknown = Reflect.get(globalThis, "ScrollTimeline");
	return isScrollTimelineConstructor(value) ? value : undefined;
}

function canAnimate(el: Element): boolean {
	return typeof Reflect.get(el, "animate") === "function";
}

/** Bind a `motion=${…}` style to `el`. */
export function bindMotionDom(
	el: Element,
	value: unknown,
	cleanups: Disposer[],
): void {
	const style = readMotionStyle(value);
	const m = model();
	if (m === undefined) return;
	if (!canAnimate(el)) {
		for (const key of MOTION_KEYS) {
			const node = style[key];
			if (node !== undefined) bindInline(el, key, node, m, cleanups);
		}
		return;
	}
	const groups = new Map<Group, Map<MotionKey, MotionNode>>();
	for (const key of MOTION_KEYS) {
		const node = style[key];
		if (node === undefined) continue;
		const group = groups.get(GROUP_OF[key]) ?? new Map<MotionKey, MotionNode>();
		group.set(key, node);
		groups.set(GROUP_OF[key], group);
	}
	for (const [group, nodes] of groups) {
		bindAnimated(el, group, nodes, m, cleanups);
	}
}

function isMotionValue(value: unknown): value is MotionValue {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "tag") === "number" &&
		typeof Reflect.get(value, "set") === "function"
	);
}

/** Feed `value` from `el`'s scroll offset (`scroll-y=${value}`). */
export function bindScrollDom(
	el: Element,
	value: unknown,
	cleanups: Disposer[],
): void {
	const m = model();
	if (m === undefined || !isMotionValue(value)) return;
	const root = m.root(value.tag);
	scrollers.set(root, el);
	const timeline = scrollTimelineClass() !== undefined && canAnimate(el);
	const onScroll = (): void => {
		// With a scroll timeline the bindings move by themselves: the value is
		// only kept current for code that reads it.
		if (timeline) m.value(root, el.scrollTop);
		else value.set(el.scrollTop);
	};
	el.addEventListener("scroll", onScroll, { passive: true });
	// The range is what a scroll timeline's keyframes span: rebuild them when
	// the container or its content changes size.
	let observer: ResizeObserver | undefined;
	if (timeline && typeof ResizeObserver === "function") {
		observer = new ResizeObserver(() => {
			for (const watcher of [...(rangeWatchers.get(root) ?? [])]) watcher();
		});
		observer.observe(el);
		for (const child of Array.from(el.children)) observer.observe(child);
	}
	for (const watcher of [...(rangeWatchers.get(root) ?? [])]) watcher();
	cleanups.push(() => {
		el.removeEventListener("scroll", onScroll);
		observer?.disconnect();
		if (scrollers.get(root) === el) scrollers.delete(root);
	});
}

function bindAnimated(
	el: Element,
	group: Group,
	nodes: Map<MotionKey, MotionNode>,
	m: MotionModel,
	cleanups: Disposer[],
): void {
	let current: Animation | undefined;
	const roots = new Set([...nodes.values()].map((node) => m.root(node.tag)));
	/** The group's values with each node read through `read`. */
	const values = (read: (node: MotionNode) => number): GroupValues => {
		const out: GroupValues = {};
		for (const [key, node] of nodes) out[key] = read(node);
		return out;
	};
	const render = (): void => {
		current?.cancel();
		current = undefined;
		const ScrollTimeline = scrollTimelineClass();
		const scroller = [...roots]
			.map((root) => scrollers.get(root))
			.find((found) => found !== undefined);
		if (scroller !== undefined && ScrollTimeline !== undefined) {
			current = scrollAnimation(el, group, nodes, m, scroller, ScrollTimeline);
			return;
		}
		// The one animated value drives the keyframes; the others hold. Two
		// animating at once are sampled together from now, for the longer.
		const animated = [...nodes.values()]
			.map((node) => ({ node, track: m.track(node.tag) }))
			.filter((entry) => entry.track.kind === "samples");
		const first = animated[0];
		if (first === undefined || first.track.kind !== "samples") {
			current = el.animate(
				[
					groupFrame(
						group,
						values((node) => m.read(node.tag)),
					),
				],
				{ duration: 0, fill: "forwards" },
			);
			return;
		}
		const track = first.track;
		const start = animated.length === 1 ? track.start : performance.now();
		const count = Math.max(
			...animated.map((entry) =>
				entry.track.kind === "samples" ? entry.track.samples.length : 1,
			),
		);
		const keyframes: Keyframe[] = [];
		for (let i = 0; i < count; i++) {
			const at = start + i * MOTION_FRAME_MS;
			keyframes.push(
				groupFrame(
					group,
					values((node) => m.read(node.tag, at)),
				),
			);
		}
		current = el.animate(keyframes, {
			duration: count * MOTION_FRAME_MS,
			iterations:
				animated.length === 1 && track.loop ? Number.POSITIVE_INFINITY : 1,
			fill: "forwards",
		});
		// In step with the value's clock: an element bound after the animation
		// started joins it where it is.
		current.currentTime = Math.max(0, performance.now() - start);
	};
	render();
	const unwatches = [...nodes.values()].map((node) =>
		m.watch(node.tag, render),
	);
	for (const root of roots) {
		const ranges = rangeWatchers.get(root) ?? new Set();
		ranges.add(render);
		rangeWatchers.set(root, ranges);
	}
	cleanups.push(() => {
		for (const unwatch of unwatches) unwatch();
		for (const root of roots) rangeWatchers.get(root)?.delete(render);
		current?.cancel();
	});
}

/** Keyframes over the scroll range, on the container's scroll timeline. */
function scrollAnimation(
	el: Element,
	group: Group,
	nodes: Map<MotionKey, MotionNode>,
	m: MotionModel,
	scroller: Element,
	ScrollTimeline: ScrollTimelineConstructor,
): Animation {
	const range = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
	const steps = range === 0 ? 0 : 32;
	const keyframes: Keyframe[] = [];
	for (let i = 0; i <= steps; i++) {
		const offset = steps === 0 ? 0 : (i / steps) * range;
		const values: GroupValues = {};
		for (const [key, node] of nodes) {
			// A node fed by this container maps the offset; any other holds.
			values[key] =
				scrollers.get(m.root(node.tag)) === scroller
					? m.map(node.tag, offset)
					: m.read(node.tag);
		}
		keyframes.push({
			...groupFrame(group, values),
			offset: steps === 0 ? 0 : i / steps,
		});
	}
	return el.animate(keyframes, {
		timeline: new ScrollTimeline({ source: scroller, axis: "block" }),
		fill: "both",
	});
}

/** Inline styles, per element: every bound key's current value. */
const inlineState = new WeakMap<Element, Map<MotionKey, number>>();

function hasStyle(el: Element): el is HTMLElement | SVGElement {
	return "style" in el && typeof Reflect.get(el, "style") === "object";
}

function writeInline(el: Element, values: Map<MotionKey, number>): void {
	if (!hasStyle(el)) return;
	const style = el.style;
	const opacity = values.get("opacity");
	if (opacity !== undefined) style.opacity = String(opacity);
	const visible = values.get("visible");
	if (visible !== undefined) {
		style.visibility = visible > 0.5 ? "visible" : "hidden";
	}
	const parts: string[] = [];
	const tx = values.get("translateX");
	const ty = values.get("translateY");
	const scale = values.get("scale");
	if (tx !== undefined) parts.push(`translateX(${tx}px)`);
	if (ty !== undefined) parts.push(`translateY(${ty}px)`);
	if (scale !== undefined) parts.push(`scale(${scale})`);
	if (parts.length > 0) style.transform = parts.join(" ");
}

function nextFrame(callback: () => void): () => void {
	if (typeof requestAnimationFrame === "function") {
		const id = requestAnimationFrame(callback);
		return () => cancelAnimationFrame(id);
	}
	const id = setTimeout(callback, MOTION_FRAME_MS);
	return () => clearTimeout(id);
}

function bindInline(
	el: Element,
	key: MotionKey,
	node: MotionNode,
	m: MotionModel,
	cleanups: Disposer[],
): void {
	const values = inlineState.get(el) ?? new Map<MotionKey, number>();
	inlineState.set(el, values);
	let cancel: (() => void) | undefined;
	const paint = (): void => {
		cancel = undefined;
		values.set(key, m.read(node.tag));
		writeInline(el, values);
		if (m.track(node.tag).kind === "samples") cancel = nextFrame(paint);
	};
	const render = (): void => {
		cancel?.();
		paint();
	};
	render();
	const unwatch = m.watch(node.tag, render);
	cleanups.push(() => {
		unwatch();
		cancel?.();
	});
}
