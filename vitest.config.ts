import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// rmapi-js imports "crc-32/crc32c" without an extension; esbuild
			// resolves that in the production bundle, but node-style resolution
			// under vitest does not (GP_E5_S1 imports rmapi-js in tests).
			"crc-32/crc32c": "crc-32/crc32c.js",
		},
	},
	test: {
		include: ["src/__tests__/**/*.test.ts"],
		server: {
			deps: {
				// Route rmapi-js through the vite pipeline so the alias above
				// applies to its internal imports too.
				inline: ["rmapi-js"],
			},
		},
	},
});
