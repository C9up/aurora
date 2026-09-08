/**
 * A cached asset must be CHECKABLE, not merely trusted for a while.
 *
 * `serveAssets` emitted `public, max-age=60` and no validator, and
 * `pageAssetsHandler` took that default. Page modules are SOURCE files in
 * development: an edited page was handed back stale for a minute, with no way
 * for the browser even to ask whether it had changed.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serveAssets } from "../../src/server/serveAssets.js";

let root: string;

async function fixture(name: string, content: string) {
	root = await mkdtemp(join(tmpdir(), "aurora-assets-"));
	await writeFile(join(root, name), content, "utf8");
	return root;
}

/** A context recording what the handler answered, with optional headers in. */
function call(path: string, requestHeaders?: Record<string, string>) {
	const headers: Record<string, string> = {};
	let status = 200;
	let body: string | Buffer = "";
	const response = {
		status(code: number) {
			status = code;
			return response;
		},
		header(name: string, value: string) {
			headers[name] = value;
			return response;
		},
		send(sent: string | Buffer) {
			body = sent;
		},
	};
	const request = {
		param: () => path,
		...(requestHeaders === undefined
			? {}
			: { header: (name: string) => requestHeaders[name.toLowerCase()] }),
	};
	return {
		ctx: { request, response },
		read: () => ({ status, headers, body: body.toString() }),
	};
}

afterEach(() => {
	root = "";
});

describe("aurora > serveAssets validators", () => {
	it("sends an ETag with the body", async () => {
		const handler = serveAssets({
			root: await fixture("page.js", "export const a = 1"),
		});
		const probe = call("page.js");
		await handler(probe.ctx);

		const { status, headers, body } = probe.read();
		expect(status).toBe(200);
		expect(body).toBe("export const a = 1");
		expect(headers.etag).toMatch(/^"[\w-]+"$/);
	});

	it("answers 304 with no body when the client already has it", async () => {
		const handler = serveAssets({
			root: await fixture("page.js", "export const a = 1"),
		});
		const first = call("page.js");
		await handler(first.ctx);
		const etag = first.read().headers.etag;
		if (etag === undefined)
			throw new Error("the first response must carry an ETag");

		const again = call("page.js", { "if-none-match": etag });
		await handler(again.ctx);

		const { status, body } = again.read();
		expect(status).toBe(304);
		// A 304 carrying a body is a protocol error, and some clients then render
		// the empty payload instead of their cached copy.
		expect(body).toBe("");
	});

	it("changes the ETag when the content changes", async () => {
		const dir = await fixture("page.js", "export const a = 1");
		const handler = serveAssets({ root: dir });
		const before = call("page.js");
		await handler(before.ctx);

		await writeFile(join(dir, "page.js"), "export const a = 2", "utf8");
		const after = call("page.js");
		await handler(after.ctx);

		expect(after.read().headers.etag).not.toBe(before.read().headers.etag);
		expect(after.read().status).toBe(200);
	});

	it("still serves a host that cannot read request headers", async () => {
		// `header()` is optional on the duck-typed request: a host that only
		// implements `param()` must keep working, just without conditionals.
		const handler = serveAssets({ root: await fixture("page.js", "x") });
		const probe = call("page.js");
		await handler(probe.ctx);

		expect(probe.read().status).toBe(200);
		expect(probe.read().body).toBe("x");
	});
});

/**
 * `If-None-Match` is a list, not a string.
 *
 * A strict `===` answered 200 for three shapes a real client sends — `*`, a
 * comma-separated list, and the weak form `W/"…"` — so a browser holding the
 * exact bytes downloaded them again, which is most of what the validator exists
 * to prevent.
 */
describe("aurora > matching If-None-Match", () => {
	async function etagFor(content: string) {
		const handler = serveAssets({ root: await fixture("page.js", content) });
		const probe = call("page.js");
		await handler(probe.ctx);
		const tag = probe.read().headers.etag;
		if (tag === undefined) throw new Error("no ETag");
		return { handler, tag };
	}

	it("answers 304 to a list containing the tag", async () => {
		const { handler, tag } = await etagFor("export const a = 1");
		const probe = call("page.js", { "if-none-match": `"other", ${tag}` });

		await handler(probe.ctx);

		expect(probe.read().status).toBe(304);
	});

	it("answers 304 to the weak form of the same tag", async () => {
		const { handler, tag } = await etagFor("export const a = 1");
		const probe = call("page.js", { "if-none-match": `W/${tag}` });

		await handler(probe.ctx);

		expect(probe.read().status).toBe(304);
	});

	it("answers 304 to `*`", async () => {
		// "any current representation" — a stored copy always matches.
		const { handler } = await etagFor("export const a = 1");
		const probe = call("page.js", { "if-none-match": "*" });

		await handler(probe.ctx);

		expect(probe.read().status).toBe(304);
	});

	it("still sends the body when the tag does not match", async () => {
		const { handler } = await etagFor("export const a = 1");
		const probe = call("page.js", { "if-none-match": '"stale", "older"' });

		await handler(probe.ctx);

		expect(probe.read().status).toBe(200);
		expect(probe.read().body).toBe("export const a = 1");
	});
});
