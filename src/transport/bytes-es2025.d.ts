/**
 * Ambient types for the ES2025 Uint8Array bytes-conversion methods
 * (GP_E5_S19). The project's `lib` is ES2020 (tsconfig.json), which doesn't
 * know these exist; without this, any code calling `.toHex()`/`.toBase64()`
 * or `Uint8Array.fromHex()`/`fromBase64()` — rmapi-js internally, and this
 * plugin's tests exercising the polyfill — hits `@typescript-eslint`'s
 * "unsafe call" rule because the property resolves to an error type. This
 * only adds type information; `bytescompat.ts` is what actually supplies the
 * methods on a runtime that lacks them.
 *
 * Options are inlined (not named interfaces) so this file has no exported
 * identifier for other modules to accidentally depend on — `bytescompat.ts`
 * keeps its own local option types.
 */

interface Uint8Array {
	toHex(): string;
	toBase64(options?: { alphabet?: "base64" | "base64url"; omitPadding?: boolean }): string;
}

interface Uint8ArrayConstructor {
	fromHex(hex: string): Uint8Array;
	fromBase64(
		base64: string,
		options?: {
			alphabet?: "base64" | "base64url";
			lastChunkHandling?: "loose" | "strict" | "stop-before-partial";
		},
	): Uint8Array;
}
