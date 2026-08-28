import { describe, expect, it } from "vitest";

/**
 * Real-Chromium proof of what the nonce buys.
 *
 * A Content-Security-Policy naming a nonce blocks every inline script that
 * lacks it. The served HTML is byte-identical either way, so the whole failure
 * is invisible to an HTTP test: the page renders, the assertions pass, and it
 * simply never hydrates. That is exactly how it reached production — diffing
 * the DOM with and without CSP showed no difference.
 *
 * happy-dom enforces no CSP at all, so this has to be a browser test.
 */

/** Apply a policy to this document, for scripts inserted afterwards. */
function applyPolicy(content: string): HTMLMetaElement {
	const meta = document.createElement("meta");
	meta.httpEquiv = "Content-Security-Policy";
	meta.content = content;
	document.head.appendChild(meta);
	return meta;
}

/** Insert an inline script that records that it ran, and report whether it did. */
function runsInline(nonce?: string): boolean {
	const marker = `csp_probe_${Math.random().toString(36).slice(2)}`;
	const script = document.createElement("script");
	if (nonce !== undefined) script.setAttribute("nonce", nonce);
	script.textContent = `window.${marker} = true`;
	document.body.appendChild(script);
	const ran = Reflect.get(window, marker) === true;
	script.remove();
	Reflect.deleteProperty(window, marker);
	return ran;
}

describe("aurora > CSP nonce > what the browser actually enforces", () => {
	it("blocks an inline script with no nonce, and runs the one that carries it", () => {
		// One policy, two scripts: the only difference is the attribute aurora
		// now emits. This is the assertion the HTML-level tests cannot make.
		const nonce = "aurora-test-nonce";
		const meta = applyPolicy(`script-src 'self' 'nonce-${nonce}'`);
		try {
			expect(runsInline()).toBe(false);
			expect(runsInline(nonce)).toBe(true);
		} finally {
			meta.remove();
		}
	});

	it("blocks a script carrying the wrong nonce", () => {
		// Why aurora must read the nonce rather than generate one: a value that
		// does not appear in the policy header blocks the page just as surely as
		// no value at all.
		const meta = applyPolicy("script-src 'self' 'nonce-the-real-one'");
		try {
			expect(runsInline("a-different-one")).toBe(false);
		} finally {
			meta.remove();
		}
	});
});
