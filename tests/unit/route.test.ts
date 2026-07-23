import { describe, expect, it } from "vitest";
import { auroraRoute, html } from "../../src/index.js";
import type { AuroraHttpContext, AuroraResponse } from "../../src/route.js";

function makeCtx(): {
	ctx: AuroraHttpContext;
	getBody: () => string;
} {
	let body = "";
	const response: AuroraResponse = {
		status() {
			return response;
		},
		header() {
			return response;
		},
		send(data: string) {
			body = data;
		},
	};
	return { ctx: { request: {}, response }, getBody: () => body };
}

describe("aurora > auroraRoute", () => {
	it("escapes the default shell module entry attribute", async () => {
		const handler = auroraRoute({
			entry: '/client.js" onerror="alert(1)',
			render: () => html`<p>ok</p>`,
		});
		const { ctx, getBody } = makeCtx();

		await handler(ctx);

		expect(getBody()).toContain(
			'src="/client.js&quot; onerror=&quot;alert(1)"',
		);
		expect(getBody()).not.toContain('src="/client.js" onerror="alert(1)"');
	});
});
