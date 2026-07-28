/**
 * A minimal ZIP writer, store-only (GP_E3_S21).
 *
 * An EPUB is a ZIP of five small text files. JSZip did that job, but it pulls
 * in a `setImmediate` polyfill whose IE-era fallbacks create `<script>`
 * elements and call `new Function` — which is why Obsidian's plugin scan
 * reported dynamic code execution in a plugin that has none of its own. None
 * of that machinery was ever reached; it was simply along for the ride.
 *
 * Writing the archive here removes the dependency, the polyfill and the
 * finding in one go, and it costs little: stored entries need no compression
 * at all, and the EPUB specification *requires* the `mimetype` entry to be
 * stored uncompressed and first anyway.
 *
 * Deterministic on purpose — a fixed timestamp — so sending an unchanged note
 * twice produces identical bytes.
 */

/** The DOS epoch (1980-01-01 00:00). Fixed so the output is reproducible. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
/** Version 2.0: the floor for a stored entry. */
const VERSION = 20;
/** Bit 11: names and comments are UTF-8. */
const UTF8_FLAG = 0x0800;

export interface ZipEntry {
	name: string;
	data: string | Uint8Array;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Pack the entries into a ZIP archive, in the order given. The first entry
 * stays first in the file, which is what makes a valid EPUB.
 */
export function zipStore(entries: ZipEntry[]): Uint8Array {
	const encoder = new TextEncoder();
	const prepared = entries.map((entry) => {
		const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
		return { name: encoder.encode(entry.name), data, crc: crc32(data) };
	});

	const localSize = prepared.reduce(
		(total, entry) => total + 30 + entry.name.length + entry.data.length,
		0,
	);
	const centralSize = prepared.reduce((total, entry) => total + 46 + entry.name.length, 0);
	const out = new Uint8Array(localSize + centralSize + 22);
	const view = new DataView(out.buffer);

	let at = 0;
	const offsets: number[] = [];
	for (const entry of prepared) {
		offsets.push(at);
		view.setUint32(at, LOCAL_HEADER, true);
		view.setUint16(at + 4, VERSION, true);
		view.setUint16(at + 6, UTF8_FLAG, true);
		view.setUint16(at + 8, 0, true); // method: stored
		view.setUint16(at + 10, DOS_TIME, true);
		view.setUint16(at + 12, DOS_DATE, true);
		view.setUint32(at + 14, entry.crc, true);
		view.setUint32(at + 18, entry.data.length, true); // compressed size
		view.setUint32(at + 22, entry.data.length, true); // uncompressed size
		view.setUint16(at + 26, entry.name.length, true);
		view.setUint16(at + 28, 0, true); // extra field length
		at += 30;
		out.set(entry.name, at);
		at += entry.name.length;
		out.set(entry.data, at);
		at += entry.data.length;
	}

	const centralStart = at;
	prepared.forEach((entry, index) => {
		view.setUint32(at, CENTRAL_HEADER, true);
		view.setUint16(at + 4, VERSION, true); // version made by
		view.setUint16(at + 6, VERSION, true); // version needed
		view.setUint16(at + 8, UTF8_FLAG, true);
		view.setUint16(at + 10, 0, true); // method: stored
		view.setUint16(at + 12, DOS_TIME, true);
		view.setUint16(at + 14, DOS_DATE, true);
		view.setUint32(at + 16, entry.crc, true);
		view.setUint32(at + 20, entry.data.length, true);
		view.setUint32(at + 24, entry.data.length, true);
		view.setUint16(at + 28, entry.name.length, true);
		view.setUint16(at + 30, 0, true); // extra field length
		view.setUint16(at + 32, 0, true); // comment length
		view.setUint16(at + 34, 0, true); // disk number
		view.setUint16(at + 36, 0, true); // internal attributes
		view.setUint32(at + 38, 0, true); // external attributes
		view.setUint32(at + 42, offsets[index], true);
		at += 46;
		out.set(entry.name, at);
		at += entry.name.length;
	});

	view.setUint32(at, END_OF_CENTRAL, true);
	view.setUint16(at + 4, 0, true); // disk number
	view.setUint16(at + 6, 0, true); // disk with central directory
	view.setUint16(at + 8, prepared.length, true);
	view.setUint16(at + 10, prepared.length, true);
	view.setUint32(at + 12, at - centralStart, true);
	view.setUint32(at + 16, centralStart, true);
	view.setUint16(at + 20, 0, true); // comment length
	return out;
}
