import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "jsdom",
		// jsdom unit tests only. The real-browser layer lives in
		// `tests/browser/**` and runs via `vitest.browser.config.ts` (Playwright/
		// Chromium) — see the `test:browser` script.
		include: ["tests/unit/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			// A floor, not a target: set just under what the suite covers today, so
			// a change that stops testing a path fails here instead of landing.
			thresholds: {
				lines: 86,
				statements: 84,
				branches: 72,
				functions: 84,
			},
		},
	},
});
