/**
 * What ends when a visit leaves the page, while the document stays.
 *
 * A full load tears everything down with the document. A visit (`visits: true`)
 * keeps the document and swaps the root's page, so what the old page started
 * outside its own components — a live component's subscription and listener —
 * registers here and ends with it.
 */

const leaving = new Set<() => void>();

/** Run `end` when a visit leaves this page. Returns what takes it back. */
export function onPageLeave(end: () => void): () => void {
	leaving.add(end);
	return () => {
		leaving.delete(end);
	};
}

/** @internal The visit is leaving the page: end what it registered. */
export function leavePage(): void {
	for (const end of [...leaving]) {
		leaving.delete(end);
		end();
	}
}
