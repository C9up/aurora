import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "happy-dom",
		// Alias the optional `@c9up/ream` peer to a local stub so the suite
		// runs standalone (agnostic). The runtime resolves the real peer only
		// when aurora actually runs inside Ream.
		alias: {
			"@c9up/ream/services/router": fileURLToPath(
				new URL("./tests/stubs/ream-router.ts", import.meta.url),
			),
		},
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
		},
	},
});
