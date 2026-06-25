import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Real-browser layer: runs the SSR↔hydration roundtrip in actual Chromium so the
// browser's HTML parser (SVG foreign content, text-node merging, table tbody…) is
// exercised — happy-dom is too lenient and misses those divergences. Point at a
// chromium binary via AURORA_CHROMIUM locally; CI uses `playwright install`.
const executablePath = process.env.AURORA_CHROMIUM;

export default defineConfig({
	test: {
		include: ["tests/browser/**/*.test.ts"],
		browser: {
			enabled: true,
			headless: true,
			provider: playwright({
				launch: executablePath ? { executablePath } : {},
			}),
			instances: [{ browser: "chromium" }],
		},
	},
});
