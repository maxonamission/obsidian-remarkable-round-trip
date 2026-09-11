import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BYTE_COMPAT_MARKER,
	ByteCompatReport,
	fromBase64Polyfill,
	fromHexPolyfill,
	installByteCompat,
	toBase64Polyfill,
	toHexPolyfill,
} from "../transport/bytescompat";

// RFC 4648 §10 test vectors.
const BASE64_VECTORS: [string, string][] = [
	["", ""],
	["f", "Zg=="],
	["fo", "Zm8="],
	["foo", "Zm9v"],
	["foob", "Zm9vYg=="],
	["fooba", "Zm9vYmE="],
	["foobar", "Zm9vYmFy"],
];

function ascii(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function randomBytes(length: number): Uint8Array {
	const out = new Uint8Array(length);
	// Deterministic PRNG (mulberry32) rather than Math.random/crypto: a fixed
	// seed keeps a failing round-trip reproducible.
	let seed = 0x9e3779b9;
	for (let i = 0; i < length; i++) {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = seed;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
	}
	return out;
}

const PROTO_NAMES = ["toHex", "toBase64"];
const CTOR_NAMES = ["fromHex", "fromBase64", BYTE_COMPAT_MARKER];

describe("installByteCompat", () => {
	// Save and restore rather than delete: on a runtime that *has* the native
	// methods (Node ≥ 25, current Electron) deleting them would strip them for
	// the rest of the worker, breaking the comparison test below and anything
	// else running in the same process.
	let saved: Map<string, PropertyDescriptor | undefined>;

	beforeEach(() => {
		const proto = Uint8Array.prototype as unknown as object;
		const ctor = Uint8Array as unknown as object;
		saved = new Map();
		for (const name of PROTO_NAMES) {
			saved.set(`proto.${name}`, Object.getOwnPropertyDescriptor(proto, name));
		}
		for (const name of CTOR_NAMES) {
			saved.set(`ctor.${name}`, Object.getOwnPropertyDescriptor(ctor, name));
		}
	});

	afterEach(() => {
		// Undo whatever this test defined, so tests don't leak state into each
		// other or into other test files that import this module.
		const proto = Uint8Array.prototype as unknown as Record<string, unknown>;
		const ctor = Uint8Array as unknown as Record<string, unknown>;
		for (const name of PROTO_NAMES) {
			const descriptor = saved.get(`proto.${name}`);
			if (descriptor) Object.defineProperty(proto, name, descriptor);
			else delete proto[name];
		}
		for (const name of CTOR_NAMES) {
			const descriptor = saved.get(`ctor.${name}`);
			if (descriptor) Object.defineProperty(ctor, name, descriptor);
			else delete ctor[name];
		}
	});

	it("polyfills base64 against the RFC 4648 test vectors", () => {
		installByteCompat();
		for (const [plain, encoded] of BASE64_VECTORS) {
			expect(ascii(plain).toBase64()).toBe(encoded);
			expect(Array.from(Uint8Array.fromBase64(encoded))).toEqual(Array.from(ascii(plain)));
		}
	});

	it("polyfills hex, including empty input and bytes above 0x7f", () => {
		installByteCompat();
		expect(new Uint8Array([]).toHex()).toBe("");
		expect(Uint8Array.fromHex("")).toEqual(new Uint8Array([]));

		const bytes = new Uint8Array([0x00, 0x0f, 0x10, 0x7f, 0x80, 0xff]);
		expect(bytes.toHex()).toBe("000f107f80ff");
		expect(Array.from(Uint8Array.fromHex("000f107f80ff"))).toEqual(Array.from(bytes));

		// Uppercase input is valid hex too.
		expect(Array.from(Uint8Array.fromHex("FF00"))).toEqual([0xff, 0x00]);
	});

	it("rejects invalid hex input", () => {
		installByteCompat();
		expect(() => Uint8Array.fromHex("abc")).toThrow(SyntaxError); // odd length
		expect(() => Uint8Array.fromHex("zz")).toThrow(SyntaxError); // not hex digits
	});

	it("follows the spec on base64 whitespace, padding and alphabets", () => {
		installByteCompat();
		// Whitespace is ignored, padding may be missing ("loose" handling).
		expect(Array.from(Uint8Array.fromBase64("Zm9v YmFy\n"))).toEqual(Array.from(ascii("foobar")));
		expect(Array.from(Uint8Array.fromBase64("Zm8"))).toEqual(Array.from(ascii("fo")));
		// One leftover character can never be a whole byte.
		expect(() => Uint8Array.fromBase64("Zm9vY")).toThrow(SyntaxError);

		const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
		expect(bytes.toBase64()).toBe("+/+/");
		expect(bytes.toBase64({ alphabet: "base64url" })).toBe("-_-_");
		expect(bytes.toBase64({ alphabet: "base64url", omitPadding: true })).toBe("-_-_");
		expect(Array.from(Uint8Array.fromBase64("-_-_", { alphabet: "base64url" }))).toEqual(
			Array.from(bytes),
		);
		// Each alphabet rejects the other's characters.
		expect(() => Uint8Array.fromBase64("-_-_")).toThrow(SyntaxError);
		expect(() => Uint8Array.fromBase64("+/+/", { alphabet: "base64url" })).toThrow(SyntaxError);
	});

	it("round-trips hex and base64 over a pseudo-random buffer", () => {
		installByteCompat();
		const bytes = randomBytes(4096);
		expect(Array.from(Uint8Array.fromHex(bytes.toHex()))).toEqual(Array.from(bytes));
		expect(Array.from(Uint8Array.fromBase64(bytes.toBase64()))).toEqual(Array.from(bytes));
	});

	it("serves the exact call rmapi-js makes: SHA-256 digest to hex", async () => {
		// raw.js:209 — `new Uint8Array(await crypto.subtle.digest("SHA-256", buff)).toHex()`
		// is the call that failed in issue #5. Assert the whole shape, not just
		// the helper, against the published SHA-256 vector for "abc".
		installByteCompat();
		// Copied into a plain ArrayBuffer: `crypto.subtle.digest` types its
		// input as BufferSource, which a Uint8Array over an ArrayBufferLike
		// does not satisfy under this tsconfig.
		const input = new ArrayBuffer(3);
		new Uint8Array(input).set(ascii("abc"));
		const digest = await crypto.subtle.digest("SHA-256", input);
		expect(new Uint8Array(digest).toHex()).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("does not touch methods a runtime already has", () => {
		const proto = Uint8Array.prototype as unknown as Record<string, unknown>;
		const ctor = Uint8Array as unknown as Record<string, unknown>;
		const fakeToHex = () => "fake-hex";
		const fakeToBase64 = () => "fake-base64";
		const fakeFromHex = () => new Uint8Array([1]);
		const fakeFromBase64 = () => new Uint8Array([2]);
		Object.defineProperty(proto, "toHex", { value: fakeToHex, configurable: true });
		Object.defineProperty(proto, "toBase64", { value: fakeToBase64, configurable: true });
		Object.defineProperty(ctor, "fromHex", { value: fakeFromHex, configurable: true });
		Object.defineProperty(ctor, "fromBase64", { value: fakeFromBase64, configurable: true });

		const report = installByteCompat();

		expect(report).toEqual<ByteCompatReport>({
			toHex: true,
			toBase64: true,
			fromHex: true,
			fromBase64: true,
		});
		// Identity, not just behaviour: our polyfill must never have replaced these.
		expect(proto.toHex).toBe(fakeToHex);
		expect(proto.toBase64).toBe(fakeToBase64);
		expect(ctor.fromHex).toBe(fakeFromHex);
		expect(ctor.fromBase64).toBe(fakeFromBase64);
	});

	it("is idempotent: calling it twice changes nothing the second time", () => {
		const firstReport = installByteCompat();
		const proto = Uint8Array.prototype as unknown as Record<string, unknown>;
		const ctor = Uint8Array as unknown as Record<string, unknown>;
		const afterFirst = {
			toHex: proto.toHex,
			toBase64: proto.toBase64,
			fromHex: ctor.fromHex,
			fromBase64: ctor.fromBase64,
		};

		const secondReport = installByteCompat();

		// Second call sees "already there" for everything the first call added.
		expect(secondReport).toEqual<ByteCompatReport>({ toHex: true, toBase64: true, fromHex: true, fromBase64: true });
		expect(proto.toHex).toBe(afterFirst.toHex);
		expect(proto.toBase64).toBe(afterFirst.toBase64);
		expect(ctor.fromHex).toBe(afterFirst.fromHex);
		expect(ctor.fromBase64).toBe(afterFirst.fromBase64);
		expect(firstReport).toBeDefined();
	});

	it("matches the native implementation where this runtime already has one (skips otherwise)", () => {
		// Compares the exported *Polyfill functions directly against whatever
		// native method this runtime happens to have — no monkey-patching of
		// Uint8Array needed for that. Dev Node at the time of writing (22) has
		// none of the four (GP_E5_S19 background), so each branch below is
		// skipped there; it still runs wherever the runtime does have one.
		const proto = Uint8Array.prototype as unknown as Record<string, unknown>;
		const ctor = Uint8Array as unknown as Record<string, unknown>;
		const nativeToHex =
			typeof proto.toHex === "function" ? (proto.toHex as (this: Uint8Array) => string) : undefined;
		const nativeToBase64 =
			typeof proto.toBase64 === "function" ? (proto.toBase64 as (this: Uint8Array) => string) : undefined;
		const nativeFromHex =
			typeof ctor.fromHex === "function" ? (ctor.fromHex as (hex: string) => Uint8Array) : undefined;
		const nativeFromBase64 =
			typeof ctor.fromBase64 === "function"
				? (ctor.fromBase64 as (b64: string) => Uint8Array)
				: undefined;

		const bytes = randomBytes(256);
		if (nativeToHex) {
			expect(toHexPolyfill(bytes)).toBe(nativeToHex.call(bytes));
		}
		if (nativeToBase64) {
			expect(toBase64Polyfill(bytes)).toBe(nativeToBase64.call(bytes));
		}
		if (nativeFromHex) {
			const hex = toHexPolyfill(bytes);
			expect(Array.from(fromHexPolyfill(hex))).toEqual(Array.from(nativeFromHex(hex)));
		}
		if (nativeFromBase64) {
			const b64 = toBase64Polyfill(bytes);
			expect(Array.from(fromBase64Polyfill(b64))).toEqual(Array.from(nativeFromBase64(b64)));
		}
	});
});
