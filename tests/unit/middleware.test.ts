import { describe, expect, it, vi } from "vitest";
import {
	type AuroraRequestRenderer,
	auroraContext,
} from "../../src/middleware.js";

interface FakeResponse {
	status(code: number): FakeResponse;
	header(name: string, value: string): FakeResponse;
	send(body: string): void;
}
interface TestCtx {
	request: object;
	response: FakeResponse;
	containerResolver?: { make(token: unknown): unknown };
	aurora?: AuroraRequestRenderer;
}

function makeCtx(resolver?: { make(token: unknown): unknown }): TestCtx {
	const response: FakeResponse = {
		status: () => response,
		header: () => response,
		send: () => {},
	};
	return { request: {}, response, containerResolver: resolver };
}

describe("aurora > auroraContext middleware", () => {
	it("binds ctx.aurora.render delegating to the resolved manager (with ctx)", async () => {
		const manager = { render: vi.fn(async () => {}) };
		const resolver = {
			make: (token: unknown) => (token === "aurora" ? manager : undefined),
		};
		const ctx = makeCtx(resolver);

		let nexted = false;
		await auroraContext(ctx, async () => {
			nexted = true;
		});

		expect(nexted).toBe(true);
		expect(ctx.aurora).toBeDefined();
		await ctx.aurora?.render("Dashboard", { user: 1 }, { lang: "fr" });
		expect(manager.render).toHaveBeenCalledWith(
			ctx,
			"Dashboard",
			{ user: 1 },
			{ lang: "fr" },
		);
	});

	it("is a no-op (no ctx.aurora) when no manager is registered", async () => {
		const ctx = makeCtx({ make: () => undefined });
		await auroraContext(ctx, async () => {});
		expect(ctx.aurora).toBeUndefined();
	});

	it("is a no-op when there is no container resolver at all", async () => {
		const ctx = makeCtx(undefined);
		await auroraContext(ctx, async () => {});
		expect(ctx.aurora).toBeUndefined();
	});
});
