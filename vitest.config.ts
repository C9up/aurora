import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "happy-dom",
		// happy-dom unit tests only. The real-browser layer lives in
		// `tests/browser/**` and runs via `vitest.browser.config.ts` (Playwright/
		// Chromium) — see the `test:browser` script.
		include: ["tests/unit/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
		},
	},
});
