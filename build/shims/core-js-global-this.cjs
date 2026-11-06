/**
 * core-js' global-object lookup, without its last-resort fallback (GP_E5_S28).
 *
 * rmapi-js 14 imports a handful of core-js polyfills (bytes conversion, async
 * dispose). They install only when the runtime lacks the feature, the same
 * policy as our own `bytescompat.ts`. To find the global object, core-js
 * tries `globalThis`, `window`, `self`, `global` and `this`, and only then
 * `Function('return this')()`. Obsidian's plugin scan reads that fallback as
 * dynamic code execution, as it did with JSZip's polyfills (GP_E3_S21).
 *
 * Every runtime this plugin ships to has `globalThis` (Electron ≥ 39,
 * iOS Safari ≥ 16, Android Chrome ≥ 100; see `.stylelintrc.json`), so the
 * first branch of core-js' own lookup always wins there. This keeps exactly
 * that branch. CommonJS on purpose: core-js `require`s this module and uses
 * the export directly.
 */
"use strict";

module.exports = globalThis;
