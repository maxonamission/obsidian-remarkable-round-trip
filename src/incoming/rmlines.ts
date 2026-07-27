/**
 * Minimal reader for reMarkable ".lines" v6 files (PRD F12).
 *
 * No JavaScript library exists for this format — only Python (rmscene) and
 * Rust — so this is a hand-written reader, deliberately limited to what the
 * round-trip needs: the stroke geometry. Text layers, layer metadata and
 * CRDT bookkeeping are walked past, not modelled.
 *
 * Format, verified against real v6 files from rmscene's test data:
 * - 43-byte ASCII header;
 * - then blocks: length uint32, unknown uint8, minVersion uint8,
 *   currentVersion uint8, blockType uint8, followed by `length` bytes;
 * - block type 0x05 carries a scene item. Its payload is a CRDT sequence
 *   item (four tagged ids, a deleted-length) optionally followed by a
 *   value subblock; inside that, item type 3 marks a line, followed by
 *   tool, colour, thickness, starting length and a subblock of points;
 * - a point is 14 bytes in version 2 (x,y float32; speed,width uint16;
 *   direction,pressure uint8) and 24 bytes in version 1 (all float32).
 *
 * Anything unexpected makes the reader stop and return what it has: a
 * partially readable page is worth more than an exception (N3).
 */

export interface StrokePoint {
	x: number;
	y: number;
	/** Pen width at this point, in device units. */
	width: number;
	/** 0-255; unreliable for some tools, so rendering treats it as a hint. */
	pressure: number;
}

export interface Stroke {
	tool: number;
	color: number;
	thicknessScale: number;
	points: StrokePoint[];
}

export const RM_V6_HEADER = "reMarkable .lines file, version=6          ";

/** reMarkable pen ids that mean "erase", which must not be drawn. */
const ERASER_TOOLS = new Set([6, 8, 38]);

const TAG_LENGTH4 = 0xc;
const ITEM_TYPE_LINE = 3;
const BLOCK_TYPE_SCENE_ITEM = 0x05;
/**
 * Text highlights made with the "smart" highlighter on a PDF text layer.
 * Beta finding 2026-07-26: the account held no `.highlights/*.json` at all,
 * yet the tablet clearly showed highlights — on this firmware they live in
 * the page's own `.rm` file as a glyph range, next to the pen strokes.
 */
const BLOCK_TYPE_GLYPH_ITEM = 0x03;
/** Tag byte for field 5 as a length-prefixed block: the highlighted text. */
const TAG_TEXT = 0x5c;
/** Tag byte for field 4 as a uint32: the highlight colour. */
const TAG_COLOR = 0x44;

/** A stretch of PDF text the reader marked with the highlighter. */
export interface RmHighlight {
	text: string;
	color?: number;
	/**
	 * Every small tagged integer in the glyph block, by tag index — raw, for
	 * diagnosis. Beta 2026-07-27: the field we took for the colour reads 9 for
	 * yellow, blue *and* pink, so it is the tool, not the colour. Logging the
	 * lot is how the real colour field gets identified without guessing.
	 */
	fields?: Record<number, number>;
}

class Cursor {
	offset: number;

	constructor(
		private readonly view: DataView,
		start: number,
		readonly end: number,
	) {
		this.offset = start;
	}

	get remaining(): number {
		return this.end - this.offset;
	}

	u8(): number {
		return this.view.getUint8(this.offset++);
	}

	u16(): number {
		const value = this.view.getUint16(this.offset, true);
		this.offset += 2;
		return value;
	}

	u32(): number {
		const value = this.view.getUint32(this.offset, true);
		this.offset += 4;
		return value;
	}

	f32(): number {
		const value = this.view.getFloat32(this.offset, true);
		this.offset += 4;
		return value;
	}

	f64(): number {
		const value = this.view.getFloat64(this.offset, true);
		this.offset += 8;
		return value;
	}

	varuint(): number {
		let shift = 0;
		let value = 0;
		for (;;) {
			const byte = this.u8();
			value |= (byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) return value;
			shift += 7;
			if (shift > 28) throw new Error("varuint too long");
		}
	}

	tag(): { index: number; type: number } {
		const byte = this.u8();
		return { index: byte >> 4, type: byte & 0xf };
	}

	/** Tagged CRDT id: one byte plus a varuint. Value is not needed here. */
	skipCrdtId(): void {
		this.tag();
		this.u8();
		this.varuint();
	}
}

function readPoints(cursor: Cursor, byteLength: number, version: number): StrokePoint[] {
	const pointSize = version === 1 ? 24 : 14;
	const count = Math.floor(byteLength / pointSize);
	const points: StrokePoint[] = [];
	for (let i = 0; i < count; i++) {
		if (cursor.remaining < pointSize) break;
		const x = cursor.f32();
		const y = cursor.f32();
		let width: number;
		let pressure: number;
		if (version === 1) {
			cursor.f32(); // speed
			cursor.f32(); // direction
			width = Math.round(cursor.f32() * 4);
			pressure = cursor.f32() * 255;
		} else {
			cursor.u16(); // speed
			width = cursor.u16();
			cursor.u8(); // direction
			pressure = cursor.u8();
		}
		points.push({ x, y, width, pressure });
	}
	return points;
}

/** Read one scene-item block; returns null when it holds no line. */
function readSceneItem(cursor: Cursor, version: number): Stroke | null {
	for (let i = 0; i < 4; i++) cursor.skipCrdtId();
	cursor.tag();
	cursor.u32(); // deleted length

	if (cursor.remaining <= 0) return null;
	const valueTag = cursor.tag();
	if (valueTag.type !== TAG_LENGTH4) return null; // item without a value
	cursor.u32(); // subblock length

	const itemType = cursor.u8();
	if (itemType !== ITEM_TYPE_LINE) return null;

	cursor.tag();
	const tool = cursor.u32();
	cursor.tag();
	const color = cursor.u32();
	cursor.tag();
	const thicknessScale = cursor.f64();
	cursor.tag();
	cursor.f32(); // starting length

	const pointsTag = cursor.tag();
	if (pointsTag.type !== TAG_LENGTH4) return null;
	const pointsBytes = cursor.u32();

	return { tool, color, thicknessScale, points: readPoints(cursor, pointsBytes, version) };
}

/**
 * Read the highlighted text out of a glyph block.
 *
 * Deliberately a validated scan rather than a strict field walk: the field
 * order around the text has varied across firmware, while the text field
 * itself is unmistakable — a length-prefixed block whose declared size must
 * match its varint length plus the flag byte plus the bytes, and whose bytes
 * must be valid UTF-8. Anything that fails those two checks is not the text.
 */
function readGlyphHighlight(
	view: DataView,
	bytes: Uint8Array,
	start: number,
	end: number,
): RmHighlight | null {
	for (let at = start; at + 6 < end; at++) {
		if (bytes[at] !== TAG_TEXT) continue;
		const blockLength = view.getUint32(at + 1, true);
		if (blockLength <= 1 || at + 5 + blockLength > end) continue;

		let length = 0;
		let shift = 0;
		let varBytes = 0;
		let valid = true;
		for (;;) {
			const byte = bytes[at + 5 + varBytes];
			length |= (byte & 0x7f) << shift;
			varBytes++;
			if ((byte & 0x80) === 0) break;
			shift += 7;
			if (varBytes > 4) {
				valid = false;
				break;
			}
		}
		// varint + the is-ascii flag + the characters fill the block exactly.
		if (!valid || length <= 0 || varBytes + 1 + length !== blockLength) continue;

		const from = at + 5 + varBytes + 1;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(
				bytes.subarray(from, from + length),
			);
			if (text.trim() === "") continue;
			return {
				text,
				color: readGlyphColor(view, bytes, start, at),
				fields: readTaggedInts(view, bytes, start, end),
			};
		} catch {
			continue; // not text after all; keep looking
		}
	}
	return null;
}

/** Small tagged uint32 fields anywhere in the block, for diagnosis only. */
function readTaggedInts(
	view: DataView,
	bytes: Uint8Array,
	start: number,
	end: number,
): Record<number, number> {
	const fields: Record<number, number> = {};
	for (let at = start; at + 5 <= end; at++) {
		if ((bytes[at] & 0x0f) !== 0x4) continue;
		const index = bytes[at] >> 4;
		if (index === 0) continue;
		const value = view.getUint32(at + 1, true);
		if (value < 4096 && fields[index] === undefined) fields[index] = value;
	}
	return fields;
}

/** The colour field sits before the text; take the nearest plausible one. */
function readGlyphColor(
	view: DataView,
	bytes: Uint8Array,
	start: number,
	before: number,
): number | undefined {
	for (let at = before - 5; at >= start; at--) {
		if (bytes[at] !== TAG_COLOR) continue;
		const value = view.getUint32(at + 1, true);
		if (value < 32) return value;
	}
	return undefined;
}

export function isRmV6(bytes: Uint8Array): boolean {
	if (bytes.length < RM_V6_HEADER.length) return false;
	let header = "";
	for (let i = 0; i < RM_V6_HEADER.length; i++) header += String.fromCharCode(bytes[i]);
	return header === RM_V6_HEADER;
}

/**
 * Extract the drawable strokes from a `.rm` v6 page. Returns [] for
 * anything it cannot read — including older format versions, which simply
 * have no v6 header.
 */
export function parseRmLines(bytes: Uint8Array): Stroke[] {
	return parseRmPage(bytes).strokes;
}

/** Everything a page holds, plus what block types were seen (diagnostics). */
export interface RmPage {
	strokes: Stroke[];
	highlights: RmHighlight[];
	/** Block type → count, so an unread page can still be explained. */
	blockTypes: Record<number, number>;
}

/**
 * Walk a `.rm` v6 page once and take both what was drawn and what was
 * highlighted. Returns empty for anything it cannot read — including older
 * format versions, which simply have no v6 header.
 */
export function parseRmPage(bytes: Uint8Array): RmPage {
	const page: RmPage = { strokes: [], highlights: [], blockTypes: {} };
	if (!isRmV6(bytes)) return page;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = RM_V6_HEADER.length;

	while (offset + 8 <= bytes.length) {
		const length = view.getUint32(offset, true);
		const currentVersion = view.getUint8(offset + 6);
		const blockType = view.getUint8(offset + 7);
		const start = offset + 8;
		const end = start + length;
		if (end > bytes.length) break; // truncated file: keep what we have

		page.blockTypes[blockType] = (page.blockTypes[blockType] ?? 0) + 1;
		try {
			if (blockType === BLOCK_TYPE_SCENE_ITEM) {
				const stroke = readSceneItem(new Cursor(view, start, end), currentVersion);
				if (stroke && stroke.points.length > 0 && !ERASER_TOOLS.has(stroke.tool)) {
					page.strokes.push(stroke);
				}
			} else if (blockType === BLOCK_TYPE_GLYPH_ITEM) {
				const highlight = readGlyphHighlight(view, bytes, start, end);
				if (highlight !== null) page.highlights.push(highlight);
			}
		} catch {
			// An unreadable block costs us that item, not the page.
		}
		offset = end;
	}
	return page;
}
