import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";
import { readFileSync } from "fs";

const prod = process.argv[2] === "production";

// Version-stamped banner: every build gets bytes unique to its version, so a
// release asset's sha256 digest never collides with an older release (les uit
// Readability Compass, BC_E1_S26).
const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;

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
