/**
 * Motion values: numbers that animate where the host animates best, bound to
 * an element's opacity, translation, scale or visibility.
 *
 *     const x = new MotionValue(0)
 *     const fade = x.interpolate([0, 200], [1, 0.2])
 *     html`<div motion=${{ translateX: x, opacity: fade }}>…</div>`
 *     x.timing(200, { duration: 300 })
 *     x.spring(0, { stiffness: 180, damping: 12 })
 *
 * One API on every host. The value lives in a driver: on the web, the model
 * below, whose animations the DOM renderer hands to the Web Animations API
 * (opacity and transform run on the compositor, so a busy main thread does
 * not stop them); on a phone, orbit's native host, which plays them on the
 * UI thread. A component that animates is the same file on both.
 *
 * Bindings: `motion=${{ opacity, translateX, translateY, scale, visible }}`
 * on an element, and `scroll-y=${value}` on a scroll container, which feeds
 * `value` from its scroll offset. Rotation and colour are not supported on
 * either host.
 */

import { E_AURORA_INVALID_MOTION } from "./errors.js";

/** What holds and animates motion values for a host. */
export interface MotionDriver {
	value(tag: number, initial: number): void;
	set(tag: number, value: number): void;
	stop(tag: number): void;
	/**
	 * Play `frames` — progress from the current value (0) to `to` (1), one per
	 * 60 Hz frame — once, or forever when `loop`.
	 */
	frames(
		tag: number,
		frames: readonly number[],
		to: number,
		loop: boolean,
	): void;
	spring(
		tag: number,
		to: number,
		stiffness: number,
		damping: number,
		mass: number,
	): void;
	interpolate(
		tag: number,
		input: number,
		from: readonly number[],
		to: readonly number[],
	): void;
	dispose(tag: number): void;
}

/** The length of one frame of a sampled curve, in ms (60 Hz, as the native host). */
export const MOTION_FRAME_MS = 1000 / 60;

/** Piecewise-linear map from `from` to `to`, clamped at both ends. */
export function interpolateNumber(
	x: number,
	from: readonly number[],
	to: readonly number[],
): number {
	const first = to[0] ?? x;
	if (from.length < 2 || to.length !== from.length) return first;
	if (x <= (from[0] ?? 0)) return first;
	for (let i = 1; i < from.length; i++) {
		const hi = from[i] ?? 0;
		if (x <= hi) {
			const lo = from[i - 1] ?? 0;
			const a = to[i - 1] ?? 0;
			const b = to[i] ?? 0;
			return hi === lo ? b : a + ((x - lo) / (hi - lo)) * (b - a);
		}
	}
	return to[to.length - 1] ?? x;
}

/**
 * A spring from `from` to `to`, at rest at the start, sampled once per 60 Hz
 * frame until it settles: semi-implicit Euler in 1 ms steps, the integrator
 * and the settling rule of orbit's native host.
 */
export function springSamples(
	from: number,
	to: number,
	stiffness: number,
	damping: number,
	mass: number,
): number[] {
	const m = Math.max(mass, 1e-3);
	const samples = [from];
	let x = from;
	let v = 0;
	const h = MOTION_FRAME_MS / 1000 / 17;
	// Ten seconds at most: a spring that never settles stops there.
	for (let frame = 0; frame < 600; frame++) {
		for (let step = 0; step < 17; step++) {
			const a = (-stiffness * (x - to) - damping * v) / m;
			v += a * h;
			x += v * h;
		}
		if (Math.abs(v) < 1e-3 && Math.abs(x - to) < 1e-3) {
			samples.push(to);
			return samples;
		}
		samples.push(x);
	}
	samples.push(to);
	return samples;
}

/** What a value does now: hold a number, or play absolute samples from `start`. */
export type MotionTrack =
	| { readonly kind: "static"; readonly value: number }
	| {
			readonly kind: "samples";
			/** Absolute values, one per {@link MOTION_FRAME_MS}. */
			readonly samples: readonly number[];
			/** When the first sample plays, on `performance.now()`'s clock. */
			readonly start: number;
			readonly loop: boolean;
	  };

type ModelNode =
	| { kind: "value"; value: number }
	| {
			kind: "interpolation";
			input: number;
			from: readonly number[];
			to: readonly number[];
	  };

const now = (): number =>
	typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * The driver of every host that does not bring its own: the browser, and the
 * server (where values are built and never animate). It holds each value and
 * its animation as samples on a clock, so what an element shows at any time
 * is known ahead — what the DOM renderer gives the Web Animations API.
 */
export class MotionModel implements MotionDriver {
	readonly #nodes = new Map<number, ModelNode>();
	readonly #tracks = new Map<number, MotionTrack>();
	readonly #watchers = new Map<number, Set<() => void>>();

	value(tag: number, initial: number): void {
		this.#nodes.set(tag, { kind: "value", value: initial });
	}

	set(tag: number, value: number): void {
		this.#nodes.set(tag, { kind: "value", value });
		this.#tracks.delete(tag);
		this.#changed(tag);
	}

	stop(tag: number): void {
		const value = this.read(tag);
		this.#tracks.delete(tag);
		this.#nodes.set(tag, { kind: "value", value });
		this.#changed(tag);
	}

	frames(
		tag: number,
		frames: readonly number[],
		to: number,
		loop: boolean,
	): void {
		const from = this.read(tag);
		const samples = frames.map((f) => from + f * (to - from));
		this.#play(tag, samples, loop);
	}

	spring(
		tag: number,
		to: number,
		stiffness: number,
		damping: number,
		mass: number,
	): void {
		const from = this.read(tag);
		this.#play(tag, springSamples(from, to, stiffness, damping, mass), false);
	}

	interpolate(
		tag: number,
		input: number,
		from: readonly number[],
		to: readonly number[],
	): void {
		this.#nodes.set(tag, { kind: "interpolation", input, from, to });
	}

	dispose(tag: number): void {
		this.#nodes.delete(tag);
		this.#tracks.delete(tag);
		this.#watchers.delete(tag);
	}

	/** The value at `at` (default: now). */
	read(tag: number, at: number = now()): number {
		const node = this.#nodes.get(tag);
		if (node === undefined) return 0;
		if (node.kind === "interpolation") {
			return interpolateNumber(this.read(node.input, at), node.from, node.to);
		}
		const track = this.#tracks.get(tag);
		return track === undefined ? node.value : sampleAt(track, at);
	}

	/** The value `tag` is computed from: itself, or the root of its interpolations. */
	root(tag: number): number {
		const node = this.#nodes.get(tag);
		return node?.kind === "interpolation" ? this.root(node.input) : tag;
	}

	/** `x` of the root, through `tag`'s interpolations. */
	map(tag: number, x: number): number {
		const node = this.#nodes.get(tag);
		if (node?.kind !== "interpolation") return x;
		return interpolateNumber(this.map(node.input, x), node.from, node.to);
	}

	/** What the root value of `tag` does now. */
	track(tag: number): MotionTrack {
		const root = this.root(tag);
		const track = this.#tracks.get(root);
		if (track !== undefined && !ended(track)) return track;
		return { kind: "static", value: this.read(root) };
	}

	/** Called whenever `tag`'s root value is set, animated or stopped. */
	watch(tag: number, watcher: () => void): () => void {
		const root = this.root(tag);
		const set = this.#watchers.get(root) ?? new Set();
		set.add(watcher);
		this.#watchers.set(root, set);
		return () => {
			set.delete(watcher);
		};
	}

	#play(tag: number, samples: readonly number[], loop: boolean): void {
		const last = samples[samples.length - 1];
		// Where the value lands once a one-shot animation is over.
		if (!loop && last !== undefined) {
			this.#nodes.set(tag, { kind: "value", value: last });
		}
		this.#tracks.set(tag, { kind: "samples", samples, start: now(), loop });
		this.#changed(tag);
	}

	#changed(tag: number): void {
		for (const watcher of [...(this.#watchers.get(tag) ?? [])]) watcher();
	}
}

function ended(track: MotionTrack): boolean {
	if (track.kind !== "samples" || track.loop) return false;
	return now() - track.start >= track.samples.length * MOTION_FRAME_MS;
}

/** A millionth of a frame, in frames: see {@link sampleAt}. */
const FRAME_EPSILON = 1e-6;

function sampleAt(track: MotionTrack, at: number): number {
	if (track.kind === "static") return track.value;
	const { samples, start, loop } = track;
	if (samples.length === 0) return 0;
	// `start + i * MOTION_FRAME_MS - start` comes back a hair under `i` for
	// many `i` (1000.3 as a start misses 65 of the first 181 frames), and a
	// plain floor then reads the frame before: the keyframes built from these
	// reads repeat a sample and end one short of the target. A millionth of a
	// frame absorbs the rounding and moves no real frame boundary.
	let index = Math.floor((at - start) / MOTION_FRAME_MS + FRAME_EPSILON);
	if (index < 0) index = 0;
	if (index >= samples.length) {
		index = loop ? index % samples.length : samples.length - 1;
	}
	return samples[index] ?? 0;
}

let driver: MotionDriver = new MotionModel();

/** The driver motion values use: the model, unless a host installed its own. */
export function motionDriver(): MotionDriver {
	return driver;
}

/** Install a host's driver (orbit's native host does, when it starts). */
export function setMotionDriver(next: MotionDriver): void {
	driver = next;
}

let nextTag = 1;

/** A value that can feed a style: a motion value, or an interpolation of one. */
export class MotionNode {
	readonly tag: number;

	constructor(tag: number) {
		this.tag = tag;
	}

	/**
	 * Forget this value (or interpolation) on its host, with its animation
	 * and what it drives. A value made for a view that goes for good is
	 * disposed with it.
	 */
	dispose(): void {
		driver.dispose(this.tag);
	}

	/** Linear map from `input` to `output`, clamped at both ends. */
	interpolate(input: readonly number[], output: readonly number[]): MotionNode {
		const tag = nextTag++;
		driver.interpolate(tag, this.tag, input, output);
		return new MotionNode(tag);
	}
}

const easeInOut = (t: number): number =>
	t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

const frameCount = (duration: number): number =>
	Math.max(1, Math.round(duration / MOTION_FRAME_MS));

export interface TimingOptions {
	/** In ms. Default 300. */
	duration?: number;
	/** Start again from the beginning once over, forever. */
	loop?: boolean;
	/** Play forward then back (with `loop`: back and forth). */
	yoyo?: boolean;
}

export interface SpringOptions {
	/** Default 180. */
	stiffness?: number;
	/** Default 12. */
	damping?: number;
	/** Default 1. */
	mass?: number;
}

export class MotionValue extends MotionNode {
	constructor(initial: number) {
		const tag = nextTag++;
		driver.value(tag, initial);
		super(tag);
	}

	/** Jump to `value`, stopping any animation. */
	set(value: number): void {
		driver.set(this.tag, value);
	}

	/** Stop where it is. */
	stop(): void {
		driver.stop(this.tag);
	}

	/** Eased tween to `to`, sampled once into 60 Hz frames the host plays. */
	timing(
		to: number,
		{ duration = 300, loop = false, yoyo = false }: TimingOptions = {},
	): void {
		const count = frameCount(duration);
		const frames: number[] = [];
		for (let i = 0; i <= count; i++) frames.push(easeInOut(i / count));
		if (yoyo) for (let i = count - 1; i >= 0; i--) frames.push(frames[i] ?? 0);
		driver.frames(this.tag, frames, to, loop);
	}

	/**
	 * Hold the current value for `duration` ms, then jump to `to` — on the
	 * same frames as `timing`, so it lands the frame a `timing` started with
	 * it ends.
	 */
	after(duration: number, to: number): void {
		const count = frameCount(duration);
		const frames: number[] = [];
		for (let i = 0; i < count; i++) frames.push(0);
		frames.push(1);
		driver.frames(this.tag, frames, to, false);
	}

	/** A physical spring to `to`, from where it is, at rest. */
	spring(
		to: number,
		{ stiffness = 180, damping = 12, mass = 1 }: SpringOptions = {},
	): void {
		driver.spring(this.tag, to, stiffness, damping, mass);
	}
}

/** The style properties a `motion` binding may drive. */
export interface MotionStyle {
	opacity?: MotionNode;
	/** In px (dp on a phone). */
	translateX?: MotionNode;
	translateY?: MotionNode;
	scale?: MotionNode;
	/**
	 * Shown above 0.5, hidden at or below: still laid out, but not drawn and
	 * not touchable — unlike `opacity` 0, which is drawn transparent and
	 * takes touches.
	 */
	visible?: MotionNode;
}

export const MOTION_KEYS = [
	"opacity",
	"translateX",
	"translateY",
	"scale",
	"visible",
] as const;

export type MotionKey = (typeof MOTION_KEYS)[number];

/** Read a `motion=${…}` value; anything but motion values is refused. */
export function readMotionStyle(value: unknown): MotionStyle {
	if (typeof value !== "object" || value === null) {
		throw new E_AURORA_INVALID_MOTION([
			"motion expects an object of motion values",
		]);
	}
	const out: MotionStyle = {};
	for (const key of MOTION_KEYS) {
		const node: unknown = Reflect.get(value, key);
		if (node instanceof MotionNode) out[key] = node;
		else if (node !== undefined) {
			throw new E_AURORA_INVALID_MOTION([
				`motion.${key} must be a motion value`,
			]);
		}
	}
	for (const key of Object.keys(value)) {
		if (!MOTION_KEYS.some((known) => known === key)) {
			throw new E_AURORA_INVALID_MOTION([
				`motion.${key} is not supported (opacity, translateX, translateY, scale, visible; rotation and colour are not)`,
			]);
		}
	}
	return out;
}
