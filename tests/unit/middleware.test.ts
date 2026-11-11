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
	containerResolver?: { make(token: unknown): Promise<unknown> };
	aurora?: AuroraRequestRenderer;
}

function makeCtx(resolver?: {
	make(token: unknown): Promise<unknown>;
}): TestCtx {
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
			make: async (token: unknown) =>
				token === "aurora" ? manager : undefined,
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
		const ctx = makeCtx({ make: async () => undefined });
		await auroraContext(ctx, async () => {});
		expect(ctx.aurora).toBeUndefined();
	});

	it("is a no-op when there is no container resolver at all", async () => {
		const ctx = makeCtx(undefined);
		await auroraContext(ctx, async () => {});
		expect(ctx.aurora).toBeUndefined();
	});
});

describe("aurora > the middleware module a kernel imports", () => {
	it("default-exports a class whose handle binds ctx.aurora", async () => {
		const mod = await import("../../src/middleware.js");
		const manager = { render: vi.fn(async () => {}) };
		const ctx = makeCtx({
			make: async (token: unknown) =>
				token === "aurora" ? manager : undefined,
		});
		const next = vi.fn(async () => {});
		await new mod.default().handle(ctx, next);
		expect(next).toHaveBeenCalledTimes(1);
		await ctx.aurora?.render("Home");
		expect(manager.render).toHaveBeenCalledWith(
			ctx,
			"Home",
			undefined,
			undefined,
		);
	});
});
