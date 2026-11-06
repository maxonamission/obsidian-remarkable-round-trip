/**
 * zod's locale catalogue, English only (GP_E5_S28).
 *
 * rmapi-js 14 validates cloud responses with zod 4 and imports it as one
 * namespace (`import { z } from "zod"`). zod re-exports a catalogue of 64
 * translated error-message sets on that namespace (`z.locales`), so every one
 * of them landed in this bundle: 370 KB of the 830 KB this upgrade added, all
 * of it loaded at every Obsidian start, on phones too.
 *
 * Nothing reads them. zod configures its default English messages by
 * importing `locales/en.js` directly (`classic/schemas.js`), not through this
 * catalogue, and rmapi-js never calls `z.config` or touches `z.locales`. So
 * the catalogue keeps English and drops the rest; `z.locales.en` still works.
 * If a future version starts using another locale, it gets `undefined` here
 * rather than a silently different language.
 */
export { default as en } from "../../node_modules/zod/v4/locales/en.js";
