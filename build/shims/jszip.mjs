/**
 * JSZip, stubbed out of the bundle (GP_E3_S21).
 *
 * `rmapi-js` imports JSZip for one method, `getDocument`, which packs a whole
 * device document into an archive. This plugin never calls it: it reads the
 * entries it needs one by one through `raw.getEntries`/`raw.getHash`. Since
 * GP_E3_S21 it writes its own EPUB archives too (`src/convert/zip.ts`), so
 * nothing here needs JSZip at all.
 *
 * It still cost something. JSZip ships as a pre-bundled file with the
 * `immediate` and `setimmediate` polyfills baked in, and their
 * pre-MutationObserver fallbacks schedule work by creating `<script>`
 * elements and calling `new Function`. Obsidian's plugin scan reads that as
 * dynamic code execution — fairly, since the code is there — in a plugin that
 * has none of its own. Bundling it also dragged in a `require("stream")`,
 * which would have broken the plugin on mobile (N7).
 *
 * So it is replaced by this. If a future code path does need JSZip, it fails
 * here with a message that says exactly what to do, rather than silently.
 */
export default class JSZipNotBundled {
	constructor() {
		throw new Error(
			"JSZip is not bundled with reMarkable Round-Trip. The plugin writes its own " +
				"archives (src/convert/zip.ts) and reads device documents entry by entry. " +
				"If a new code path needs JSZip, remove the alias in esbuild.config.mjs and " +
				"check the plugin scan and mobile support again.",
		);
	}
}
