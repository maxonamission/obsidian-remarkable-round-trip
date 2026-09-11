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

// ES2025 bytes-conversion methods (GP_E5_S19): rmapi-js calls
// `Uint8Array#toHex`/`toBase64` and the `fromHex`/`fromBase64` statics
// directly. Those don't exist on every Electron/browser/Node this plugin
// ships to, so `src/transport/bytescompat.ts` polyfills them — but only if
// `installByteCompat()` actually makes it into the bundle. A dependency
// upgrade could introduce a *new* call to one of these methods that nothing
// polyfills; catch that here, at build time, not from a user's field report.
const BYTES_API_CALLS = [/\.toHex\(/, /\.toBase64\(/, /\bfromHex\(/, /\bfromBase64\(/];
const usesBytesApi = BYTES_API_CALLS.some((pattern) => pattern.test(bundle));
const hasPolyfill = bundle.includes("GP_E5_S19_BYTE_COMPAT_POLYFILL");
if (usesBytesApi && !hasPolyfill) {
	console.error(
		"✗ bundle calls an ES2025 Uint8Array bytes method (toHex/toBase64/fromHex/" +
			"fromBase64) but does not contain the byte-compat polyfill marker.\n" +
			"  Make sure src/transport/bytescompat.ts's installByteCompat() is " +
			"imported and called from main.ts (onload, before the fetch shim) so " +
			"esbuild does not tree-shake it out — see GP_E5_S19.",
	);
	process.exit(1);
}
console.log(
	"bundle clean: no dynamic code execution, no Node builtins, bytes-conversion " +
		"polyfill present alongside its ES2025 calls",
);
