/**
 * The v6 `.rm` text-page format: writer and minimal reader in one module
 * (PRD F16/K6). Born as spike GP_E7_S1, promoted to the production path in
 * GP_E7_S2 after all three device assumptions held (Paper Pro + Type Folio,
 * 2026-08-19 — see docs/ontwerp-schrijfmodus.md §4/§6).
 *
 * The v6 format is undocumented; this follows rmscene (MIT, Rick Lupton) —
 * the same reference our stroke reader (rmlines.ts) was verified against.
 * Deliberately the smallest subset that makes a text page the device can
 * open and edit: one text item carrying the whole document text, plus a
 * paragraph-style map (K6/F18 subset). Writing NEW documents only — the safe
 * side of an undocumented format.
 */

/** Paragraph styles as the device stores them (rmscene ParagraphStyle). */
export const PARAGRAPH_STYLE = {
	basic: 0,
	plain: 1,
	heading: 2,
	bold: 3,
	bullet: 4,
	bullet2: 5,
	checkbox: 6,
	checkboxChecked: 7,
} as const;

export type ParagraphStyleValue = (typeof PARAGRAPH_STYLE)[keyof typeof PARAGRAPH_STYLE];

export interface TextParagraph {
	text: string;
	style: ParagraphStyleValue;
}

const HEADER = "reMarkable .lines file, version=6          ";

// Tag nibbles (rmscene TagType).
const TAG_ID = 0xf;
const TAG_LENGTH4 = 0xc;
const TAG_BYTE4 = 0x4;
const TAG_BYTE1 = 0x1;

// Block types used by a text-only page (rmscene simple_text_document).
const BLOCK_AUTHOR_IDS = 0x09;
const BLOCK_MIGRATION_INFO = 0x00;
const BLOCK_PAGE_INFO = 0x0a;
const BLOCK_SCENE_TREE = 0x01;
const BLOCK_ROOT_TEXT = 0x07;
const BLOCK_TREE_NODE = 0x02;
const BLOCK_SCENE_GROUP_ITEM = 0x04;
const GROUP_ITEM_TYPE = 0x02;

/** First explicit character id; ids 16..16+len-1 are the text's characters. */
const FIRST_CHAR_ID = 16;

interface CrdtId {
	part1: number;
	part2: number;
}

const id = (part1: number, part2: number): CrdtId => ({ part1, part2 });
const END_MARKER = id(0, 0);

class ByteWriter {
	private chunks: number[] = [];

	get length(): number {
		return this.chunks.length;
	}

	bytes(): Uint8Array {
		return Uint8Array.from(this.chunks);
	}

	u8(value: number): void {
		this.chunks.push(value & 0xff);
	}

	u16(value: number): void {
		this.u8(value);
		this.u8(value >>> 8);
	}

	u32(value: number): void {
		this.u16(value & 0xffff);
		this.u16(value >>> 16);
	}

	f32(value: number): void {
		const buf = new DataView(new ArrayBuffer(4));
		buf.setFloat32(0, value, true);
		for (let i = 0; i < 4; i++) this.u8(buf.getUint8(i));
	}

	f64(value: number): void {
		const buf = new DataView(new ArrayBuffer(8));
		buf.setFloat64(0, value, true);
		for (let i = 0; i < 8; i++) this.u8(buf.getUint8(i));
	}

	varuint(value: number): void {
		let v = value >>> 0;
		for (;;) {
			const byte = v & 0x7f;
			v >>>= 7;
			if (v !== 0) {
				this.u8(byte | 0x80);
			} else {
				this.u8(byte);
				break;
			}
		}
	}

	raw(bytes: Uint8Array | number[]): void {
		for (const b of bytes) this.chunks.push(b & 0xff);
	}

	tag(index: number, type: number): void {
		this.varuint((index << 4) | type);
	}

	crdtId(value: CrdtId): void {
		this.u8(value.part1);
		this.varuint(value.part2);
	}

	taggedId(index: number, value: CrdtId): void {
		this.tag(index, TAG_ID);
		this.crdtId(value);
	}

	taggedBool(index: number, value: boolean): void {
		this.tag(index, TAG_BYTE1);
		this.u8(value ? 1 : 0);
	}

	taggedInt(index: number, value: number): void {
		this.tag(index, TAG_BYTE4);
		this.u32(value);
	}

	taggedFloat(index: number, value: number): void {
		this.tag(index, TAG_BYTE4);
		this.f32(value);
	}

	/** Nested length-prefixed subblock: tag, uint32 length, payload. */
	subblock(index: number, body: (w: ByteWriter) => void): void {
		const inner = new ByteWriter();
		body(inner);
		this.tag(index, TAG_LENGTH4);
		this.u32(inner.length);
		this.raw(inner.bytes());
	}

	taggedString(index: number, value: string): void {
		const encoded = new TextEncoder().encode(value);
		this.subblock(index, (w) => {
			w.varuint(encoded.length);
			w.u8(1); // "is ascii" flag; rmscene always writes true.
			w.raw(encoded);
		});
	}

	lwwString(index: number, timestamp: CrdtId, value: string): void {
		this.subblock(index, (w) => {
			w.taggedId(1, timestamp);
			w.taggedString(2, value);
		});
	}

	lwwBool(index: number, timestamp: CrdtId, value: boolean): void {
		this.subblock(index, (w) => {
			w.taggedId(1, timestamp);
			w.taggedBool(2, value);
		});
	}

	/** Top-level block envelope: length, 0, minVersion, currentVersion, type. */
	block(type: number, minVersion: number, currentVersion: number, body: (w: ByteWriter) => void): void {
		const inner = new ByteWriter();
		body(inner);
		this.u32(inner.length);
		this.u8(0);
		this.u8(minVersion);
		this.u8(currentVersion);
		this.u8(type);
		this.raw(inner.bytes());
	}
}

/**
 * Build the bytes of a v6 page that carries `paragraphs` as editable typed
 * text — the block list rmscene's `simple_text_document` produces, with the
 * style map extended to one entry per paragraph (F18 subset).
 */
export function buildTextPageRm(paragraphs: TextParagraph[]): Uint8Array {
	const text = paragraphs.map((p) => p.text).join("\n");
	const encoder = new TextEncoder();
	const w = new ByteWriter();
	w.raw(encoder.encode(HEADER));

	// Author: any stable UUID will do; zeros keep the page deterministic and
	// carry no identity (privacy, N1).
	w.block(BLOCK_AUTHOR_IDS, 1, 1, (b) => {
		b.varuint(1);
		b.subblock(0, (s) => {
			s.varuint(16);
			s.raw(new Array<number>(16).fill(0));
			s.u16(1);
		});
	});

	w.block(BLOCK_MIGRATION_INFO, 1, 1, (b) => {
		b.taggedId(1, id(1, 1));
		b.taggedBool(2, true);
		b.taggedBool(3, false); // present since firmware 3.2.2
	});

	w.block(BLOCK_PAGE_INFO, 0, 1, (b) => {
		b.taggedInt(1, 1); // loads
		b.taggedInt(2, 0); // merges
		b.taggedInt(3, text.length + 1);
		b.taggedInt(4, text.split("\n").length);
		b.taggedInt(5, 0); // typeFolioUseCount, since 3.2.2
	});

	w.block(BLOCK_SCENE_TREE, 1, 1, (b) => {
		b.taggedId(1, id(0, 11));
		b.taggedId(2, END_MARKER);
		b.taggedBool(3, true);
		b.subblock(4, (s) => s.taggedId(1, id(0, 1)));
	});

	// Root text: ONE text item carrying the whole text (character ids are
	// implicit: char i has id (1, FIRST_CHAR_ID + i)), plus one style entry
	// per paragraph, keyed by the newline character that starts it — the
	// first paragraph is keyed by the (0,0) end marker.
	const styleKeys: CrdtId[] = [END_MARKER];
	let offset = 0;
	for (let i = 0; i < paragraphs.length - 1; i++) {
		offset += paragraphs[i].text.length;
		styleKeys.push(id(1, FIRST_CHAR_ID + offset));
		offset += 1; // the newline itself
	}
	// Timestamps must be unique ids outside the character range.
	const timestampBase = FIRST_CHAR_ID + text.length + 1;

	w.block(BLOCK_ROOT_TEXT, 1, 1, (b) => {
		b.taggedId(1, END_MARKER);
		b.subblock(2, (outer) => {
			outer.subblock(1, (s) => {
				s.subblock(1, (t) => {
					t.varuint(1); // one text item
					t.subblock(0, (item) => {
						item.taggedId(2, id(1, FIRST_CHAR_ID));
						item.taggedId(3, END_MARKER);
						item.taggedId(4, END_MARKER);
						item.taggedInt(5, 0);
						item.taggedString(6, text);
					});
				});
			});
			outer.subblock(2, (s) => {
				s.subblock(1, (f) => {
					f.varuint(paragraphs.length);
					paragraphs.forEach((paragraph, index) => {
						f.crdtId(styleKeys[index]);
						f.taggedId(1, id(1, timestampBase + index));
						f.subblock(2, (v) => {
							v.u8(17); // constant rmscene writes; meaning unknown
							v.u8(paragraph.style);
						});
					});
				});
			});
		});
		b.subblock(3, (s) => {
			s.f64(-468.0); // pos_x: half the rM2 grid width, as the device writes
			s.f64(234.0); // pos_y
		});
		b.taggedFloat(4, 936.0); // text width on the device grid
	});

	w.block(BLOCK_TREE_NODE, 1, 2, (b) => {
		b.taggedId(1, id(0, 1));
		b.lwwString(2, END_MARKER, "");
		b.lwwBool(3, END_MARKER, true);
	});

	w.block(BLOCK_TREE_NODE, 1, 2, (b) => {
		b.taggedId(1, id(0, 11));
		b.lwwString(2, id(0, 12), "Layer 1");
		b.lwwBool(3, END_MARKER, true);
	});

	w.block(BLOCK_SCENE_GROUP_ITEM, 1, 1, (b) => {
		b.taggedId(1, id(0, 1));
		b.taggedId(2, id(0, 13));
		b.taggedId(3, END_MARKER);
		b.taggedId(4, END_MARKER);
		b.taggedInt(5, 0);
		b.subblock(6, (s) => {
			s.u8(GROUP_ITEM_TYPE);
			s.taggedId(2, id(0, 11));
		});
	});

	return w.bytes();
}

/* ------------------------------------------------------------------ */
/* Read-back: the reverse direction, for the round-trip (assumption 3) */
/* ------------------------------------------------------------------ */

class Cursor {
	offset = 0;
	constructor(private readonly view: DataView) {}

	get done(): boolean {
		return this.offset >= this.view.byteLength;
	}

	u8(): number {
		return this.view.getUint8(this.offset++);
	}

	u32(): number {
		const v = this.view.getUint32(this.offset, true);
		this.offset += 4;
		return v;
	}

	varuint(): number {
		let shift = 0;
		let result = 0;
		for (;;) {
			const byte = this.u8();
			result |= (byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) return result >>> 0;
			shift += 7;
		}
	}

	crdtId(): CrdtId {
		return { part1: this.u8(), part2: this.varuint() };
	}

	/** Read a tag; returns {index, type}. */
	tag(): { index: number; type: number } {
		const v = this.varuint();
		return { index: v >> 4, type: v & 0xf };
	}

	bytes(n: number): Uint8Array {
		const out = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, n);
		this.offset += n;
		return out.slice();
	}
}

/** Expect a Length4 subblock at `index`; returns a cursor over its payload. */
function subCursor(c: Cursor, index: number): Cursor {
	const tag = c.tag();
	if (tag.index !== index || tag.type !== TAG_LENGTH4) {
		throw new Error(`Expected subblock ${index}, found index ${tag.index} type ${tag.type}`);
	}
	return new Cursor(new DataView(c.bytes(c.u32()).buffer));
}

export interface ReadTextResult {
	paragraphs: TextParagraph[];
	/** Present when the page carried no root-text block at all. */
	missing?: boolean;
}

/**
 * Read the typed text of a v6 page back into paragraphs. Follows rmscene's
 * RootTextBlock reader for the subset the writer produces, tolerating the
 * device's own edits: multiple text items (in CRDT document order for the
 * simple appends/edits the spike cares about) and deleted stretches.
 */
export function readTextPageRm(bytes: Uint8Array): ReadTextResult {
	const headerLength = HEADER.length;
	const view = new DataView(bytes.buffer, bytes.byteOffset + headerLength);
	const c = new Cursor(view);

	while (!c.done) {
		const length = c.u32();
		c.u8(); // unknown
		c.u8(); // min version
		c.u8(); // current version
		const blockType = c.u8();
		const payload = new Cursor(new DataView(c.bytes(length).buffer));
		if (blockType !== BLOCK_ROOT_TEXT) continue;

		payload.tag(); // id tag (1)
		payload.crdtId();

		const outer = subCursor(payload, 2);
		const itemsOuter = subCursor(outer, 1);
		const itemsInner = subCursor(itemsOuter, 1);
		const itemCount = itemsInner.varuint();

		// Reassemble the text with per-character ids so the style keys can be
		// located even after on-device edits inserted or removed characters.
		const chars: { id: CrdtId; ch: string }[] = [];
		const decoder = new TextDecoder();
		for (let i = 0; i < itemCount; i++) {
			const item = subCursor(itemsInner, 0);
			item.tag();
			const itemId = item.crdtId();
			item.tag();
			item.crdtId(); // left
			item.tag();
			item.crdtId(); // right
			item.tag();
			const deletedLength = item.u32();
			let value = "";
			if (!item.done) {
				const str = subCursor(item, 6);
				const byteLength = str.varuint();
				str.u8(); // ascii flag
				value = decoder.decode(str.bytes(byteLength));
				// A trailing tagged int marks a formatting placeholder; the
				// spike's subset does not use it.
			}
			if (deletedLength > 0) continue;
			for (let k = 0; k < value.length; k++) {
				chars.push({ id: { part1: itemId.part1, part2: itemId.part2 + k }, ch: value[k] });
			}
		}

		const stylesOuter = subCursor(outer, 2);
		const stylesInner = subCursor(stylesOuter, 1);
		const styleCount = stylesInner.varuint();
		const styles = new Map<string, number>();
		for (let i = 0; i < styleCount; i++) {
			const key = stylesInner.crdtId();
			stylesInner.tag();
			stylesInner.crdtId(); // timestamp
			const value = subCursor(stylesInner, 2);
			value.u8(); // constant 17
			styles.set(`${key.part1}:${key.part2}`, value.u8());
		}

		// Split on newlines; the style of a paragraph is keyed by the newline
		// character that starts it (the first by the 0:0 end marker).
		const paragraphs: TextParagraph[] = [];
		let current = "";
		let currentKey = "0:0";
		const flush = () => {
			const style = (styles.get(currentKey) ?? PARAGRAPH_STYLE.plain) as ParagraphStyleValue;
			paragraphs.push({ text: current, style });
		};
		for (const { id: charId, ch } of chars) {
			if (ch === "\n") {
				flush();
				current = "";
				currentKey = `${charId.part1}:${charId.part2}`;
			} else {
				current += ch;
			}
		}
		flush();
		return { paragraphs };
	}
	return { paragraphs: [], missing: true };
}
