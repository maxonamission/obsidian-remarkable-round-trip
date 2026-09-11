/**
 * Bytes-conversion polyfill for older runtimes (GP_E5_S19).
 *
 * rmapi-js 11.1.2 calls the ES2025 `Uint8Array` bytes methods directly in its
 * raw layer: `toHex()` for the SHA-256 hash behind every write, `fromHex()`
 * for schema-3 entry hashing, and `toBase64()` for the CRC header and the
 * simple-upload metadata. Those methods only exist from Chromium 140 /
 * Electron 38 (2 September 2025) / Safari 18.2 / Firefox 133 / Node 25.
 * Obsidian ships app updates without necessarily updating the bundled
 * Electron runtime — that only changes when the user runs a fresh installer
 * — so "latest plugin, latest Obsidian" can still run on an engine that
 * lacks these methods (issue #5). Every sync-API write then fails with
 * `(intermediate value).toHex is not a function`, even though reads, pairing
 * and the simple upload endpoint (which brings its own base64, see
 * `cloud.ts`) keep working.
 *
 * This module defines only what is missing, so a runtime that already has
 * the native methods (current Node, current Electron, iOS ≥ 18.2, …) is left
 * untouched — never overwritten, per N7 (mobile parity) and to avoid masking
 * a future native implementation with our own bugs.
 *
 * rmapi-js calls every one of these with no options object, so a minimal
 * implementation would do. We still honour the standard `alphabet` /
 * `omitPadding` options for base64 (cheap to support correctly) but refuse
 * `lastChunkHandling` values other than the spec default `"loose"` rather
 * than silently decoding them wrong — nothing in this codebase needs them.
 */

export interface ByteCompatReport {
	/** True if the runtime already had this method; false if we polyfilled it. */
	toHex: boolean;
	toBase64: boolean;
	fromHex: boolean;
	fromBase64: boolean;
}

interface ToBase64Options {
	alphabet?: "base64" | "base64url";
	omitPadding?: boolean;
}

interface FromBase64Options {
	alphabet?: "base64" | "base64url";
	lastChunkHandling?: "loose" | "strict" | "stop-before-partial";
}

// Stable marker so scripts/check-bundle.mjs can confirm this polyfill shipped
// in the built bundle whenever the bundle also calls the ES2025 methods, and
// so the reference to it here keeps esbuild's tree-shaking from dropping the
// install path. Do not rename without updating that script.
export const BYTE_COMPAT_MARKER = "GP_E5_S19_BYTE_COMPAT_POLYFILL";

const HEX_BYTE = new Array<string>(256);
for (let i = 0; i < 256; i++) {
	HEX_BYTE[i] = i.toString(16).padStart(2, "0");
}

// Char code -> nibble value, -1 for anything that is not a hex digit.
// Covers the ASCII range used by "0-9a-fA-F" (max char code 102, 'f').
const HEX_NIBBLE = new Int8Array(128).fill(-1);
for (let i = 0; i <= 9; i++) HEX_NIBBLE[48 + i] = i; // '0'-'9'
for (let i = 0; i < 6; i++) {
	HEX_NIBBLE[65 + i] = 10 + i; // 'A'-'F'
	HEX_NIBBLE[97 + i] = 10 + i; // 'a'-'f'
}

function nibbleOf(code: number): number {
	return code < 128 ? HEX_NIBBLE[code] : -1;
}

/**
 * The four functions below are exported (not just installed onto
 * `Uint8Array`) so tests can compare them directly against a native
 * implementation without touching global state.
 */

export function toHexPolyfill(bytes: Uint8Array): string {
	// rmapi-js only ever hexes a 32-byte SHA-256 digest, so size is not the
	// concern here; array + join rather than `+=` in a loop keeps it linear
	// anyway, should a future caller hand us something larger.
	const parts = new Array<string>(bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		parts[i] = HEX_BYTE[bytes[i]];
	}
	return parts.join("");
}

export function fromHexPolyfill(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) {
		throw new SyntaxError("Uint8Array.fromHex: string is not a valid hex string (odd length)");
	}
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		const hi = nibbleOf(hex.charCodeAt(i * 2));
		const lo = nibbleOf(hex.charCodeAt(i * 2 + 1));
		if (hi < 0 || lo < 0) {
			throw new SyntaxError("Uint8Array.fromHex: string is not a valid hex string");
		}
		out[i] = (hi << 4) | lo;
	}
	return out;
}

/**
 * Uint8Array -> binary string (one char per byte), the shape `btoa` needs.
 * The callers in rmapi-js are small (a four-byte CRC header, a JSON metadata
 * blob); array + single join rather than repeated `+=` keeps it linear if
 * that ever changes. `String.fromCharCode.apply` over the whole array would
 * be faster still, but blows the argument limit on large inputs, which is
 * exactly the case this guards against.
 */
function bytesToBinaryString(bytes: Uint8Array): string {
	const chars = new Array<string>(bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		chars[i] = String.fromCharCode(bytes[i]);
	}
	return chars.join("");
}

export function toBase64Polyfill(bytes: Uint8Array, options?: ToBase64Options): string {
	const alphabet = options?.alphabet ?? "base64";
	const omitPadding = options?.omitPadding ?? false;
	let out = btoa(bytesToBinaryString(bytes));
	if (alphabet === "base64url") {
		out = out.replace(/\+/g, "-").replace(/\//g, "_");
	}
	if (omitPadding) {
		out = out.replace(/=+$/, "");
	}
	return out;
}

export function fromBase64Polyfill(base64: string, options?: FromBase64Options): Uint8Array {
	const alphabet = options?.alphabet ?? "base64";
	const lastChunkHandling = options?.lastChunkHandling ?? "loose";
	if (lastChunkHandling !== "loose") {
		// Nothing in this codebase passes a stricter mode. Refusing it is safer
		// than decoding it as if it were "loose".
		throw new Error(
			`Uint8Array.fromBase64 polyfill: lastChunkHandling "${lastChunkHandling}" is not supported`,
		);
	}
	// Whitespace is ignored per spec, and it has to go before the length check
	// below or a padded string with a trailing newline would be rejected.
	const stripped = base64.replace(/[\t\n\f\r ]/g, "");
	// Each alphabet rejects the other's two characters. `atob` accepts "+" and
	// "/" whatever we ask of it, so base64url has to be policed here: another
	// plugin feature-detecting this method should get spec behaviour, not a
	// lenient variant of it.
	const foreign = alphabet === "base64url" ? /[+/]/ : /[-_]/;
	if (foreign.test(stripped)) {
		throw new SyntaxError(
			`Uint8Array.fromBase64: string contains characters outside the "${alphabet}" alphabet`,
		);
	}
	let normalized =
		alphabet === "base64url" ? stripped.replace(/-/g, "+").replace(/_/g, "/") : stripped;
	const remainder = normalized.length % 4;
	if (remainder === 1) {
		throw new SyntaxError("Uint8Array.fromBase64: invalid base64 string length");
	}
	if (remainder > 0) {
		// "loose" handling tolerates missing padding; atob does not.
		normalized += "=".repeat(4 - remainder);
	}
	const binary = atob(normalized);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

type AnyRecord = Record<string, unknown>;

function hasNativeMethod(target: AnyRecord, name: string): boolean {
	return typeof target[name] === "function";
}

function defineMissing(target: AnyRecord, name: string, value: unknown): void {
	Object.defineProperty(target, name, {
		value,
		enumerable: false,
		writable: true,
		configurable: true,
	});
}

/**
 * Install whatever bytes-conversion methods this runtime is missing. Safe to
 * call more than once: a method found on a later call (native, or installed
 * by an earlier call) is left alone.
 */
export function installByteCompat(): ByteCompatReport {
	const proto = Uint8Array.prototype as unknown as AnyRecord;
	const ctor = Uint8Array as unknown as AnyRecord;

	const report: ByteCompatReport = {
		toHex: hasNativeMethod(proto, "toHex"),
		toBase64: hasNativeMethod(proto, "toBase64"),
		fromHex: hasNativeMethod(ctor, "fromHex"),
		fromBase64: hasNativeMethod(ctor, "fromBase64"),
	};

	// The instance methods take the receiver as `this`; the exported
	// `*Polyfill` functions take it as an explicit argument (so tests can call
	// them without going through the prototype), hence the thin wrappers here.
	if (!report.toHex) {
		defineMissing(proto, "toHex", function toHex(this: Uint8Array): string {
			return toHexPolyfill(this);
		});
	}
	if (!report.toBase64) {
		defineMissing(
			proto,
			"toBase64",
			function toBase64(this: Uint8Array, options?: ToBase64Options): string {
				return toBase64Polyfill(this, options);
			},
		);
	}
	if (!report.fromHex) defineMissing(ctor, "fromHex", fromHexPolyfill);
	if (!report.fromBase64) defineMissing(ctor, "fromBase64", fromBase64Polyfill);

	if (!(BYTE_COMPAT_MARKER in ctor)) {
		defineMissing(ctor, BYTE_COMPAT_MARKER, true);
	}

	return report;
}
