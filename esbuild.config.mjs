import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const prod = process.argv[2] === "production";

// Version-stamped banner: every build gets bytes unique to its version, so a
// release asset's sha256 digest never collides with an older release (les uit
// Readability Compass, BC_E1_S26).
const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;

// core-js (via rmapi-js 14) finds the global object with a
// `Function('return this')()` fallback that Obsidian's scan reads as dynamic
// code. core-js requires that module by relative path, which `alias` cannot
// reach, hence a resolve hook (GP_E5_S28; shim explains why it is safe).
const coreJsGlobalThis = {
	name: "core-js-global-this",
	setup(build) {
		build.onResolve({ filter: /(^|[\\/])global-this(\.js)?$/ }, (args) =>
			/[\\/]core-js[\\/]/.test(args.resolveDir)
				? {
						path: fileURLToPath(
							new URL("build/shims/core-js-global-this.cjs", import.meta.url),
						),
					}
				: undefined,
		);
	},
};

// zod 4 (via rmapi-js 14) re-exports 64 translated message sets that nothing
// here uses; keep English only (GP_E5_S28; the shim explains why it is safe).
const zodEnglishOnly = {
	name: "zod-english-only",
	setup(build) {
		build.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, (args) =>
			/[\\/]zod[\\/]v4[\\/]/.test(args.resolveDir)
				? {
						path: fileURLToPath(
							new URL("build/shims/zod-locales.mjs", import.meta.url),
						),
					}
				: undefined,
		);
	},
};

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/state",
		"@codemirror/view",
		...builtinModules,
	],
	banner: {
		js: `/* reMarkable Round-Trip ${version} — https://github.com/maxonamission/codebase-galdhopiggen */`,
	},
	// JSZip reaches this bundle through rmapi-js, for one method this plugin
	// never calls. It arrives pre-bundled with polyfills whose legacy
	// fallbacks create `<script>` elements and call `new Function` — dynamic
	// code execution in Obsidian's plugin scan — and it drags in a
	// `require("stream")` that would break the plugin on mobile (N7). The stub
	// throws if anything ever does need it (GP_E3_S21).
	alias: {
		jszip: fileURLToPath(new URL("build/shims/jszip.mjs", import.meta.url)),
	},
	plugins: [coreJsGlobalThis, zodEnglishOnly],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
