/**
 * Local stand-in for `@c9up/ream/services/router`, aliased in vitest.config
 * so aurora's tests run standalone — without the optional `@c9up/ream` peer.
 *
 * Mirrors the slice AuroraProvider.start() touches: a `default` router whose
 * `.get()` delegates to whatever `setRouter` last installed. Tests drive
 * behaviour (slug collisions, proxy-uninit, success) through that injected
 * router; aurora's runtime contract is unchanged.
 */
interface InjectableRouter {
	get(path: string, handler?: unknown): unknown;
}

let current: InjectableRouter | undefined;

export function setRouter(router: InjectableRouter): void {
	current = router;
}

const router: InjectableRouter = {
	get(path: string, handler?: unknown): unknown {
		if (!current) {
			throw new Error("Router accessed before initialization.");
		}
		return current.get(path, handler);
	},
};

export default router;
