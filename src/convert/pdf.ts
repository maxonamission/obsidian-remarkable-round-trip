/**
 * Markdown blocks → e-ink friendly PDF (PRD F3, K1, N7).
 *
 * Pure JS/TS typesetting on top of pdf-lib: no Electron `printToPDF`, no
 * shell-outs, so the same path runs on Obsidian mobile. Layout targets the
 * reMarkable 2 screen (1404×1872 px @ 226 DPI ≈ 447×596 pt) so pages map
 * 1:1 onto the device — a stable page grid is the anchor the round-trip
 * (F10–F12) will rely on.
 *
 * Standard fonts only (WinAnsi): full Latin-1 coverage (fine for NL/EN docs);
 * characters outside WinAnsi are replaced by a close ASCII fallback. Embedding
 * a Unicode font is a known follow-up.
 */

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import type { Block, ListItem } from "./mdblocks";

export interface PdfLayoutOptions {
	/** Base body font size in points. */
	fontSize?: number;
	/** Line height as a multiple of the font size. */
	lineHeight?: number;
	/** Page margin in points. */
	margin?: number;
}

export interface PdfMetadata {
	title: string;
	/** Stable document ID (F5); stored in the PDF's Subject field. */
	docId: string;
}

/** Marker prefix used to carry the document ID inside PDF metadata. */
export const DOCID_SUBJECT_PREFIX = "remarkable-round-trip:docid:";

/** A single word and where it starts, for word-level anchoring (GP_E3_S9). */
export interface PlacedWord {
	/** Sequence number across the whole document, in reading order. */
	id: number;
	text: string;
	x: number;
	width: number;
}

/** What kind of source block a line came from (GP_E3_S12). */
export type LineRole =
	| "title"
	| "heading"
	| "paragraph"
	| "list"
	| "quote"
	| "code"
	| "table";

/** One piece of text as it was placed on the page (GP_E3_S8). */
export interface LaidOutLine {
	/** 1-based page number. */
	page: number;
	/** Baseline position in PDF points (origin bottom-left). */
	x: number;
	y: number;
	size: number;
	text: string;
	/**
	 * The line's words with their own positions. This is what lets a
	 * strike-through report *which* words were struck (GP_E3_S9).
	 */
	words: PlacedWord[];
	/** The source block this line belongs to; wrapped lines share it. */
	block: number;
	role: LineRole;
	/** Heading level, list depth, or table column — role-dependent. */
	level?: number;
	/** Numbered list marker, when the item had one. */
	ordered?: number;
}

/**
 * Where every line ended up. This is what lets imported ink be quoted
 * against the text it sits next to: the device gives strokes in page
 * coordinates, and this map turns those coordinates back into sentences.
 */
export interface PdfLayout {
	pageWidth: number;
	pageHeight: number;
	pageCount: number;
	lines: LaidOutLine[];
}

// reMarkable 2 screen in PDF points (1404×1872 px at 226 DPI).
export const PAGE_WIDTH = 447;
export const PAGE_HEIGHT = 596;

const DEFAULTS: Required<PdfLayoutOptions> = {
	fontSize: 11,
	lineHeight: 1.5,
	margin: 40,
};

/**
 * The typography actually used, defaults filled in. Recorded per upload so a
 * later import can reproduce the same page layout even when the settings have
 * changed in the meantime (GP_E3_S8).
 */
export function resolveLayoutOptions(
	options: PdfLayoutOptions = {},
): Required<PdfLayoutOptions> {
	return { ...DEFAULTS, ...options };
}

const HEADING_SIZES: Record<number, number> = {
	1: 19,
	2: 16,
	3: 14,
	4: 12,
	5: 11,
	6: 11,
};

/** Replace characters WinAnsi cannot encode with a readable ASCII fallback. */
export function toWinAnsi(text: string): string {
	const replacements: Record<string, string> = {
		"→": "->",
		"←": "<-",
		"↔": "<->",
		"–": "-",
		"—": "--",
		"‘": "'",
		"’": "'",
		"“": '"',
		"”": '"',
		"…": "...",
		" ": " ",
		"•": "-",
		"′": "'",
		"″": '"',
		"≤": "<=",
		"≥": ">=",
		"≠": "!=",
		"≈": "~",
	};
	let out = "";
	for (const ch of text.normalize("NFC")) {
		if (ch in replacements) {
			out += replacements[ch];
		} else if (ch.charCodeAt(0) <= 0xff || isWinAnsiExtra(ch)) {
			out += ch;
		} else {
			out += "?";
		}
	}
	return out;
}

function isWinAnsiExtra(ch: string): boolean {
	// Printable WinAnsi characters above U+00FF (Euro, dashes, quotes, etc.).
	return "€ŠšŽžŒœŸƒˆ˜†‡‰‹›™".includes(ch);
}

interface Typesetter {
	doc: PDFDocument;
	page: PDFPage;
	pageIndex: number;
	y: number;
	body: PDFFont;
	bold: PDFFont;
	italic: PDFFont;
	mono: PDFFont;
	opts: Required<PdfLayoutOptions>;
	/** Every placed line, in reading order (GP_E3_S8). */
	placed: LaidOutLine[];
	/** Source-block counter; wrapped lines of one block share its number. */
	block: number;
	role: LineRole;
	level?: number;
	ordered?: number;
	/** Running word counter, so a mark can name the exact words it covers. */
	wordId: number;
}

function newPage(ts: Typesetter): void {
	ts.page = ts.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
	ts.pageIndex++;
	ts.y = PAGE_HEIGHT - ts.opts.margin;
}

/**
 * Draw one line *and* remember where it landed. Every text placement goes
 * through here, so the layout map cannot silently drift from the PDF.
 */
function put(
	ts: Typesetter,
	text: string,
	x: number,
	y: number,
	size: number,
	font: PDFFont,
): void {
	ts.page.drawText(text, { x, y, size, font, color: rgb(0, 0, 0) });
	if (text.trim() !== "") {
		ts.placed.push({
			page: ts.pageIndex,
			x,
			y,
			size,
			text,
			words: placeWords(ts, text, x, font, size),
			block: ts.block,
			role: ts.role,
			level: ts.level,
			ordered: ts.ordered,
		});
	}
}

/** Start a new source block; every line drawn after this shares its number. */
function beginBlock(ts: Typesetter, role: LineRole, level?: number, ordered?: number): void {
	ts.block++;
	ts.role = role;
	ts.level = level;
	ts.ordered = ordered;
}

/**
 * Walk a drawn line word by word, advancing exactly as the renderer does, so
 * a word's recorded position is the position it occupies on the page.
 */
function placeWords(
	ts: Typesetter,
	text: string,
	x: number,
	font: PDFFont,
	size: number,
): PlacedWord[] {
	const spaceWidth = font.widthOfTextAtSize(" ", size);
	const words: PlacedWord[] = [];
	let cursor = x;
	for (const part of text.split(" ")) {
		if (part === "") {
			cursor += spaceWidth;
			continue;
		}
		const width = font.widthOfTextAtSize(part, size);
		words.push({ id: ts.wordId++, text: part, x: cursor, width });
		cursor += width + spaceWidth;
	}
	return words;
}

function ensureRoom(ts: Typesetter, needed: number): void {
	if (ts.y - needed < ts.opts.margin) newPage(ts);
}

/** Greedy word-wrap for the given font/size and maximum line width. */
export function wrapText(
	text: string,
	font: PDFFont,
	size: number,
	maxWidth: number,
): string[] {
	const words = text.split(/\s+/).filter((w) => w !== "");
	if (words.length === 0) return [];
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const candidate = current === "" ? word : `${current} ${word}`;
		if (font.widthOfTextAtSize(candidate, size) <= maxWidth || current === "") {
			current = candidate;
		} else {
			lines.push(current);
			current = word;
		}
	}
	lines.push(current);
	return lines;
}

function drawLines(
	ts: Typesetter,
	lines: string[],
	font: PDFFont,
	size: number,
	indent: number,
	extraGapAfter: number,
): void {
	const step = size * ts.opts.lineHeight;
	for (const line of lines) {
		ensureRoom(ts, step);
		ts.y -= step;
		put(ts, line, ts.opts.margin + indent, ts.y, size, font);
	}
	ts.y -= extraGapAfter;
}

function contentWidth(ts: Typesetter, indent = 0): number {
	return PAGE_WIDTH - 2 * ts.opts.margin - indent;
}

function drawHeading(ts: Typesetter, level: number, text: string): void {
	beginBlock(ts, level === 0 ? "title" : "heading", Math.max(level, 1));
	const size = HEADING_SIZES[level] ?? 11;
	const gapBefore = size * 0.8;
	ensureRoom(ts, gapBefore + size * ts.opts.lineHeight);
	ts.y -= gapBefore;
	const lines = wrapText(toWinAnsi(text), ts.bold, size, contentWidth(ts));
	drawLines(ts, lines, ts.bold, size, 0, size * 0.35);
}

function drawParagraph(ts: Typesetter, text: string): void {
	beginBlock(ts, "paragraph");
	const lines = wrapText(toWinAnsi(text), ts.body, ts.opts.fontSize, contentWidth(ts));
	drawLines(ts, lines, ts.body, ts.opts.fontSize, 0, ts.opts.fontSize * 0.6);
}

function drawList(ts: Typesetter, items: ListItem[]): void {
	const size = ts.opts.fontSize;
	const counters: number[] = [];
	let prevDepth = -1;
	for (const item of items) {
		if (item.depth > prevDepth) counters[item.depth] = 0;
		if (item.ordered) counters[item.depth] = (counters[item.depth] ?? 0) + 1;
		prevDepth = item.depth;
		// Each item is its own block: a wrapped item keeps one number, the
		// next item gets a new one.
		beginBlock(ts, "list", item.depth, item.ordered ? counters[item.depth] : undefined);

		const indent = 14 + item.depth * 14;
		const bullet = item.ordered ? `${counters[item.depth]}.` : "-";
		const lines = wrapText(toWinAnsi(item.text), ts.body, size, contentWidth(ts, indent));
		const step = size * ts.opts.lineHeight;
		ensureRoom(ts, step);
		// Bullet on the first line, hanging indent for wrapped lines.
		ts.y -= step;
		ts.page.drawText(bullet, {
			x: ts.opts.margin + indent - 12,
			y: ts.y,
			size,
			font: ts.body,
		});
		if (lines.length > 0) {
			put(ts, lines[0], ts.opts.margin + indent, ts.y, size, ts.body);
		}
		for (const line of lines.slice(1)) {
			ensureRoom(ts, step);
			ts.y -= step;
			put(ts, line, ts.opts.margin + indent, ts.y, size, ts.body);
		}
	}
	ts.y -= size * 0.6;
}

function drawQuote(ts: Typesetter, quoteLines: string[]): void {
	beginBlock(ts, "quote");
	const size = ts.opts.fontSize;
	const indent = 14;
	const text = quoteLines.join(" ").trim();
	const lines = wrapText(toWinAnsi(text), ts.italic, size, contentWidth(ts, indent));
	const step = size * ts.opts.lineHeight;
	for (const line of lines) {
		ensureRoom(ts, step);
		ts.y -= step;
		ts.page.drawText("|", {
			x: ts.opts.margin + 2,
			y: ts.y,
			size,
			font: ts.body,
		});
		put(ts, line, ts.opts.margin + indent, ts.y, size, ts.italic);
	}
	ts.y -= size * 0.6;
}

function drawCode(ts: Typesetter, codeLines: string[]): void {
	beginBlock(ts, "code");
	const size = ts.opts.fontSize - 1.5;
	const step = size * 1.3;
	for (const raw of codeLines) {
		// Hard-truncate: code is preformatted, wrapping would garble it.
		let line = toWinAnsi(raw.replace(/\t/g, "  "));
		while (line.length > 0 && ts.mono.widthOfTextAtSize(line, size) > contentWidth(ts, 8)) {
			line = line.slice(0, -1);
		}
		ensureRoom(ts, step);
		ts.y -= step;
		put(ts, line, ts.opts.margin + 8, ts.y, size, ts.mono);
	}
	ts.y -= size * 0.8;
}

/**
 * Distribute a table's total width over columns based on their natural
 * (content) widths. Fits naturally when there is room; otherwise columns
 * shrink proportionally, but never below `minWidth` (or their own natural
 * width, if smaller) so narrow columns stay readable while wide ones wrap.
 * Exported for tests (GP_E2_S11: cells wrap, content is never truncated).
 */
export function computeColumnWidths(
	naturals: number[],
	total: number,
	minWidth = 56,
): number[] {
	const sum = naturals.reduce((a, b) => a + b, 0);
	if (sum <= total) return [...naturals];
	const floors = naturals.map((n) => Math.min(minWidth, n));
	const flexTotal = total - floors.reduce((a, b) => a + b, 0);
	const flexNat = naturals.map((n, i) => n - floors[i]);
	const flexSum = flexNat.reduce((a, b) => a + b, 0);
	if (flexTotal <= 0 || flexSum <= 0) {
		return naturals.map(() => total / naturals.length);
	}
	return naturals.map((n, i) => floors[i] + (flexNat[i] * flexTotal) / flexSum);
}

function drawTable(ts: Typesetter, rows: string[][]): void {
	// Content-weighted columns; cell text wraps across lines (beta finding
	// GP_E2_S11: truncation lost content on real documents).
	const size = ts.opts.fontSize - 1;
	const step = size * ts.opts.lineHeight;
	const pad = 8;
	const total = contentWidth(ts);
	const cols = Math.max(...rows.map((r) => r.length), 1);

	const naturals = Array.from({ length: cols }, (_, c) =>
		Math.max(
			...rows.map((row, rowIndex) => {
				const font = rowIndex === 0 ? ts.bold : ts.body;
				const text = toWinAnsi(row[c] ?? "");
				return text === "" ? 0 : font.widthOfTextAtSize(text, size) + pad;
			}),
		),
	);
	const widths = computeColumnWidths(naturals, total);
	const offsets = widths.map((_, c) => widths.slice(0, c).reduce((a, b) => a + b, 0));

	rows.forEach((row, rowIndex) => {
		beginBlock(ts, "table", rowIndex);
		const font = rowIndex === 0 ? ts.bold : ts.body;
		const cellLines = row.map((cell, c) =>
			wrapText(toWinAnsi(cell), font, size, Math.max(widths[c] - pad, 24)),
		);
		const rowLines = Math.max(1, ...cellLines.map((lines) => lines.length));
		// Keep the row on one page when it fits; taller-than-page rows fall
		// back to a mid-row break via the per-line floor guard below.
		ensureRoom(ts, Math.min(rowLines * step, PAGE_HEIGHT - 2 * ts.opts.margin));
		const top = ts.y;
		let lowest = top;
		row.forEach((_cell, c) => {
			let y = top;
			for (const line of cellLines[c]) {
				y -= step;
				if (y < ts.opts.margin) break;
				put(ts, line, ts.opts.margin + offsets[c], y, size, font);
			}
			lowest = Math.min(lowest, y);
		});
		ts.y = lowest;
		if (rowIndex === 0) {
			ts.y -= 3;
			ts.page.drawLine({
				start: { x: ts.opts.margin, y: ts.y },
				end: { x: ts.opts.margin + total, y: ts.y },
				thickness: 0.5,
				color: rgb(0.4, 0.4, 0.4),
			});
			ts.y -= 3;
		}
	});
	ts.y -= size * 0.8;
}

function drawHr(ts: Typesetter): void {
	ensureRoom(ts, 14);
	ts.y -= 10;
	ts.page.drawLine({
		start: { x: ts.opts.margin, y: ts.y },
		end: { x: PAGE_WIDTH - ts.opts.margin, y: ts.y },
		thickness: 0.5,
		color: rgb(0.4, 0.4, 0.4),
	});
	ts.y -= 6;
}

export interface PdfRender {
	bytes: Uint8Array;
	/** Where the text landed, for anchoring imported ink (GP_E3_S8). */
	layout: PdfLayout;
}

/**
 * Render blocks to PDF bytes. The note title becomes an H1-style document
 * header; the document ID lands in the PDF Subject for round-trip detection.
 *
 * Returns the layout map alongside the bytes: rendering and measuring are the
 * same pass, so the two can never disagree about where a sentence sits.
 */
export async function renderPdf(
	blocks: Block[],
	meta: PdfMetadata,
	options: PdfLayoutOptions = {},
): Promise<PdfRender> {
	const opts = { ...DEFAULTS, ...options };
	const doc = await PDFDocument.create();
	doc.setTitle(meta.title);
	doc.setSubject(`${DOCID_SUBJECT_PREFIX}${meta.docId}`);
	doc.setCreator("reMarkable Round-Trip (Obsidian plugin)");

	const ts: Typesetter = {
		doc,
		page: undefined as unknown as PDFPage,
		pageIndex: 0,
		placed: [],
		block: 0,
		role: "paragraph",
		wordId: 0,
		y: 0,
		body: await doc.embedFont(StandardFonts.Helvetica),
		bold: await doc.embedFont(StandardFonts.HelveticaBold),
		italic: await doc.embedFont(StandardFonts.HelveticaOblique),
		mono: await doc.embedFont(StandardFonts.Courier),
		opts,
	};
	newPage(ts);

	drawHeading(ts, 0, meta.title);
	ts.y -= 4;

	for (const block of blocks) {
		switch (block.type) {
			case "heading":
				drawHeading(ts, block.level, block.text);
				break;
			case "paragraph":
				drawParagraph(ts, block.text);
				break;
			case "list":
				drawList(ts, block.items);
				break;
			case "quote":
				drawQuote(ts, block.lines);
				break;
			case "code":
				drawCode(ts, block.lines);
				break;
			case "table":
				drawTable(ts, block.rows);
				break;
			case "hr":
				drawHr(ts);
				break;
		}
	}

	return {
		bytes: await doc.save(),
		layout: {
			pageWidth: PAGE_WIDTH,
			pageHeight: PAGE_HEIGHT,
			pageCount: ts.pageIndex,
			lines: ts.placed,
		},
	};
}
