/**
 * Guard the built bundle against patterns Obsidian's plugin scan rejects
 * (GP_E3_S21).
 *
 * The plugin has no dynamic code execution of its own; it arrived through a
 * dependency's pre-bundled polyfills, and a future dependency could bring it
 * back the same way. This runs after every build, so that shows up here
 * rather than in a review weeks later.
 */

import { readFileSync } from "fs";

const FORBIDDEN = [
	{
		pattern: /createElement\(\s*["'`]script["'`]\s*\)/g,
		what: "dynamic <script> element creation",
	},
	{ pattern: /\bnew Function\s*\(/g, what: "new Function()" },
	{ pattern: /(^|[^.\w])eval\s*\(/g, what: "eval()" },
	{
		pattern: /require\(\s*["'`](stream|fs|path|child_process)["'`]\s*\)/g,
		what: "a Node builtin (breaks Obsidian mobile, N7)",
	},
];

const bundle = readFileSync("main.js", "utf8");
let failed = false;
for (const { pattern, what } of FORBIDDEN) {
	const hits = bundle.match(pattern);
	if (hits === null) continue;
	failed = true;
	console.error(`✗ bundle contains ${hits.length}× ${what}`);
}

if (failed) {
	console.error(
		"\nObsidian's plugin scan rejects these. They usually arrive through a " +
			"dependency's pre-bundled files — see the jszip alias in esbuild.config.mjs " +
			"for how the last one was dealt with.",
	);
	process.exit(1);
}
console.log("bundle clean: no dynamic code execution, no Node builtins");
