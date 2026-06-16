import { describe, expect, it, vi } from "vitest";
import { form } from "../../src/form.js";

interface Creds {
	email: string;
	password: string;
}

const initial: Creds = { email: "", password: "" };

describe("aurora > form", () => {
	it("field() reflects initial values and set() updates them", () => {
		const f = form({ initial, submit: () => Promise.resolve() });
		const email = f.field("email");
		expect(email.value()).toBe("");
		email.set("a@b.com");
		expect(email.value()).toBe("a@b.com");
		expect(f.values()).toEqual({ email: "a@b.com", password: "" });
	});

	it("validate() (function form) populates errors and reports validity", () => {
		const f = form({
			initial,
			submit: () => Promise.resolve(),
			validate: (v) => (v.email === "" ? { email: "required" } : {}),
		});
		expect(f.validate()).toBe(false);
		expect(f.field("email").error()).toBe("required");
		f.set("email", "a@b.com");
		expect(f.validate()).toBe(true);
		expect(f.field("email").error()).toBeNull();
	});

	it("validate() accepts a duck-typed .validate schema (rune-shaped)", () => {
		const schema = {
			validate: (v: Creds) =>
				v.email.includes("@")
					? { valid: true }
					: {
							valid: false,
							errors: [{ field: "email", message: "bad email" }],
						},
		};
		const f = form({
			initial,
			submit: () => Promise.resolve(),
			validate: schema,
		});
		expect(f.validate()).toBe(false);
		expect(f.field("email").error()).toBe("bad email");
		f.set("email", "a@b.com");
		expect(f.validate()).toBe(true);
	});

	it("handleSubmit() skips submit when invalid", async () => {
		const submit = vi.fn(() => Promise.resolve());
		const f = form({
			initial,
			submit,
			validate: (v) => (v.email === "" ? { email: "required" } : {}),
		});
		await f.handleSubmit({ preventDefault: () => {} });
		expect(submit).not.toHaveBeenCalled();
		expect(f.field("email").error()).toBe("required");
	});

	it("handleSubmit() submits when valid, toggles submitting, fires onSuccess", async () => {
		const submit = vi.fn((v: Creds) => Promise.resolve({ id: 1, ...v }));
		const seen: unknown[] = [];
		const f = form({ initial, submit }).onSuccess((d) => seen.push(d));
		f.set("email", "a@b.com");
		f.set("password", "secret123");
		expect(f.submitting()).toBe(false);
		const p = f.handleSubmit();
		expect(f.submitting()).toBe(true);
		await p;
		expect(f.submitting()).toBe(false);
		expect(submit).toHaveBeenCalledWith({
			email: "a@b.com",
			password: "secret123",
		});
		expect(seen).toEqual([{ id: 1, email: "a@b.com", password: "secret123" }]);
	});

	it("onFail fires on submit rejection; setErrors injects server errors", async () => {
		const err = new Error("server");
		const f = form({ initial, submit: () => Promise.reject(err) });
		f.onFail(() => f.setErrors({ email: "already taken" }));
		await f.handleSubmit();
		expect(f.submitError()).toBe(err);
		expect(f.field("email").error()).toBe("already taken");
	});

	it("set() clears a stale error for the edited field", () => {
		const f = form({
			initial,
			submit: () => Promise.resolve(),
			validate: (v) => (v.email === "" ? { email: "required" } : {}),
		});
		f.validate();
		expect(f.field("email").error()).toBe("required");
		f.set("email", "x");
		expect(f.field("email").error()).toBeNull();
	});

	it("touched: markTouched sets it; handleSubmit marks all", async () => {
		const f = form({ initial, submit: () => Promise.resolve() });
		expect(f.field("email").touched()).toBe(false);
		f.field("email").markTouched();
		expect(f.field("email").touched()).toBe(true);
		expect(f.field("password").touched()).toBe(false);
		await f.handleSubmit();
		expect(f.field("password").touched()).toBe(true);
	});

	it("reset() restores initial values and clears state", async () => {
		const f = form({ initial, submit: () => Promise.resolve() });
		f.set("email", "x@y.com");
		f.field("email").markTouched();
		await f.handleSubmit();
		f.reset();
		expect(f.values()).toEqual({ email: "", password: "" });
		expect(f.field("email").touched()).toBe(false);
		expect(f.field("email").error()).toBeNull();
	});

	it("onSuccess/onFail are chainable", () => {
		const f = form({ initial, submit: () => Promise.resolve() });
		expect(f.onSuccess(() => {}).onFail(() => {})).toBe(f);
	});
});
