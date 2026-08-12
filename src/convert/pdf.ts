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

/**
 * Typography behaviour version (GP_E5_S4–S7). Recorded per upload alongside
 * the font numbers: an import reproduces the layout of a sent document by
 * typesetting it again, so behaviour changes (word breaking, WinAnsi
 * typography, fill-in rows, checkboxes) must replay per document — otherwise
 * every improvement shifts the anchors of previously sent documents
 * (the GP_E3_S15 lesson). Version 1 = pre-0.29 behaviour; version 2 =
 * 0.29.0 (word breaking without float tolerance); version 3 = 0.29.1-0.30.0
 * (float tolerance, label rows); version 4 = current (keep tables together,
 * keep headings with their content).
 */
export const TYPO_VERSION = 4;

export interface PdfLayoutOptions {
	/** Base body font size in points. */
	fontSize?: number;
	/** Line height as a multiple of the font size. */
	lineHeight?: number;
	/** Page margin in points. */
	margin?: number;
	/** Typography behaviour version; defaults to the current TYPO_VERSION. */
	typo?: number;
	/** Page size in PDF points; defaults to the reMarkable 1/2 screen (GP_E6_S2). */
	pageWidth?: number;
	pageHeight?: number;
	/**
	 * Start a new page before headings up to this level (GP_E6_S4);
	 * 0 = only at explicit \pagebreak markers.
	 */
	breakAtHeading?: number;
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
export type LineRole = "title" | "heading" | "paragraph" | "list" | "quote" | "code" | "table";

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
	/** Typography behaviour version this layout was produced with. */
	typo?: number;
}

// reMarkable 2 screen in PDF points (1404×1872 px at 226 DPI).
export const PAGE_WIDTH = 447;
export const PAGE_HEIGHT = 596;

const DEFAULTS: Required<PdfLayoutOptions> = {
	fontSize: 11,
	lineHeight: 1.5,
	margin: 40,
	typo: TYPO_VERSION,
	pageWidth: PAGE_WIDTH,
	pageHeight: PAGE_HEIGHT,
	breakAtHeading: 0,
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
	// Level 0 is the document title. It carried no entry between 0.11.0 and
	// 0.16.0 — the title moved from level 1 to level 0 to give it its own
	// role, and silently fell through to the 11 pt body size. That cost more
	// than an ugly title: the title block shrank by 49.7 pt, so rebuilding the
	// layout of a document sent earlier put every row on page 1 fifty points
	// too high, and every pen mark landed three rows below where it was drawn
	// (GP_E3_S15).
	0: 19,
	1: 19,
	2: 16,
	3: 14,
	4: 12,
	5: 11,
	6: 11,
};

/**
 * Replace characters WinAnsi cannot encode with a readable ASCII fallback.
 * Dashes, curly quotes, ellipsis and bullet ARE WinAnsi (0x85–0x97) and pass
 * through untouched since GP_E5_S7 — the earlier blanket ASCII-fallback
 * turned every em dash into "--" on the page.
 */
const REPLACEMENTS: Record<string, string> = {
	"→": "->",
	"←": "<-",
	"↔": "<->",
	"\u00a0": " ",
	"′": "'",
	"″": '"',
	"≤": "<=",
	"≥": ">=",
	"≠": "!=",
	"≈": "~",
};

/** The pre-0.29 blanket fallbacks, replayed for typo-version-1 documents. */
const LEGACY_REPLACEMENTS: Record<string, string> = {
	"–": "-",
	"—": "--",
	"‘": "'",
	"’": "'",
	"“": '"',
	"”": '"',
	"…": "...",
	"•": "-",
};

export function toWinAnsi(text: string, typo: number = TYPO_VERSION): string {
	let out = "";
	for (const ch of text.normalize("NFC")) {
		if (typo < 2 && ch in LEGACY_REPLACEMENTS) {
			out += LEGACY_REPLACEMENTS[ch];
		} else if (ch in REPLACEMENTS) {
			out += REPLACEMENTS[ch];
		} else if (ch.charCodeAt(0) <= 0xff || isWinAnsiExtra(ch)) {
			out += ch;
		} else {
			out += "?";
		}
	}
	return out;
}

function isWinAnsiExtra(ch: string): boolean {
	// Printable WinAnsi characters above U+00FF: Euro, ligatures, marks — and
	// since GP_E5_S7 the typography that used to be ASCII-fallbacked: en/em
	// dash, curly quotes, ellipsis, bullet.
	return "€ŠšŽžŒœŸƒˆ˜†‡‰‹›™–—‘’“”…•".includes(ch);
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
	ts.page = ts.doc.addPage([ts.opts.pageWidth, ts.opts.pageHeight]);
	ts.pageIndex++;
	ts.y = ts.opts.pageHeight - ts.opts.margin;
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

/**
 * Float-noise guard for width comparisons (GP_E5_S4 follow-up): a table
 * column's wrap width is its own content's measured width minus and plus the
 * same padding, which re-enters as e.g. 56.129999999999995 against a word of
 * 56.13. Without the tolerance, a word that exactly fills its column is
 * "wider" by 7e-15 pt and gets broken ("Achillespee/s").
 */
const WIDTH_EPSILON = 0.01;

/** Split a single word wider than the line into chunks that fit (GP_E5_S4). */
function breakLongWord(
	word: string,
	font: PDFFont,
	size: number,
	maxWidth: number,
	epsilon: number,
): string[] {
	const parts: string[] = [];
	let current = "";
	for (const ch of word) {
		const candidate = current + ch;
		if (font.widthOfTextAtSize(candidate, size) <= maxWidth + epsilon || current === "") {
			current = candidate;
		} else {
			parts.push(current);
			current = ch;
		}
	}
	parts.push(current);
	return parts;
}

/**
 * Greedy word-wrap for the given font/size and maximum line width. A word
 * wider than the line is hard-broken mid-word (GP_E5_S4): before, it was
 * drawn as-is and overflowed — in a narrow table column that meant colliding
 * with the neighbouring column's text.
 */
export function wrapText(
	text: string,
	font: PDFFont,
	size: number,
	maxWidth: number,
	typo: number = TYPO_VERSION,
): string[] {
	const words = text.split(/\s+/).filter((w) => w !== "");
	if (words.length === 0) return [];
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const candidate = current === "" ? word : `${current} ${word}`;
		if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
			current = candidate;
			continue;
		}
		// The candidate overflows: only now is the word's own width worth
		// measuring (the fitting case above stays a single measurement). The
		// float tolerance is itself versioned: 0.29.0 (typo 2) broke words
		// without it, and its uploads must replay that way.
		const epsilon = typo >= 3 ? WIDTH_EPSILON : 0;
		if (typo >= 2 && font.widthOfTextAtSize(word, size) > maxWidth + epsilon) {
			if (current !== "") {
				lines.push(current);
			}
			const parts = breakLongWord(word, font, size, maxWidth, epsilon);
			lines.push(...parts.slice(0, -1));
			current = parts[parts.length - 1];
			continue;
		}
		if (current === "") {
			// A single word wider than the line overflows as-is: version-1
			// behaviour, and for version 2 the hairline case where the word
			// fills its column within the float tolerance.
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
	return ts.opts.pageWidth - 2 * ts.opts.margin - indent;
}

function drawHeading(ts: Typesetter, level: number, text: string): void {
	beginBlock(ts, level === 0 ? "title" : "heading", Math.max(level, 1));
	const size = HEADING_SIZES[level] ?? 11;
	const gapBefore = size * 0.8;
	// Keep-with-next (GP_E6_S5, typo 4): a heading only starts on a page if
	// at least a couple of body lines fit under it — a heading dangling at
	// the bottom belongs with its content on the next page.
	const keepWith =
		level >= 1 && ts.opts.typo >= 4 ? 2 * ts.opts.fontSize * ts.opts.lineHeight : 0;
	ensureRoom(ts, gapBefore + size * ts.opts.lineHeight + keepWith);
	ts.y -= gapBefore;
	const lines = wrapText(toWinAnsi(text, ts.opts.typo), ts.bold, size, contentWidth(ts), ts.opts.typo);
	drawLines(ts, lines, ts.bold, size, 0, size * 0.35);
}

function drawParagraph(ts: Typesetter, text: string): void {
	beginBlock(ts, "paragraph");
	const lines = wrapText(
		toWinAnsi(text, ts.opts.typo),
		ts.body,
		ts.opts.fontSize,
		contentWidth(ts),
		ts.opts.typo,
	);
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
		// A task item renders a drawn checkbox instead of the literal "[ ]"
		// (GP_E5_S6) — a square you can actually tick with the pen.
		const task = ts.opts.typo >= 2 && !item.ordered ? parseTaskMarker(item.text) : null;
		const text = task ? task.rest : item.text;
		const lines = wrapText(toWinAnsi(text, ts.opts.typo), ts.body, size, contentWidth(ts, indent), ts.opts.typo);
		const step = size * ts.opts.lineHeight;
		ensureRoom(ts, step);
		// Bullet on the first line, hanging indent for wrapped lines.
		ts.y -= step;
		if (task) {
			drawCheckbox(ts, ts.opts.margin + indent - 12, ts.y, size, task.checked);
		} else {
			ts.page.drawText(bullet, {
				x: ts.opts.margin + indent - 12,
				y: ts.y,
				size,
				font: ts.body,
			});
		}
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

/** Markdown task marker at the start of a list item: "[ ] …" or "[x] …". */
export function parseTaskMarker(text: string): { checked: boolean; rest: string } | null {
	const match = /^\[( |x|X)\]\s+(.*)$/.exec(text);
	if (!match) return null;
	return { checked: match[1] !== " ", rest: match[2] };
}

/** A drawn checkbox at the bullet position; ticked with a check for [x]. */
function drawCheckbox(ts: Typesetter, x: number, y: number, size: number, checked: boolean): void {
	const box = size * 0.75;
	ts.page.drawRectangle({
		x,
		y: y - box * 0.08,
		width: box,
		height: box,
		borderWidth: 0.8,
		borderColor: rgb(0.25, 0.25, 0.25),
	});
	if (checked) {
		const y0 = y - box * 0.08;
		ts.page.drawLine({
			start: { x: x + box * 0.2, y: y0 + box * 0.45 },
			end: { x: x + box * 0.42, y: y0 + box * 0.2 },
			thickness: 1,
			color: rgb(0.25, 0.25, 0.25),
		});
		ts.page.drawLine({
			start: { x: x + box * 0.42, y: y0 + box * 0.2 },
			end: { x: x + box * 0.85, y: y0 + box * 0.8 },
			thickness: 1,
			color: rgb(0.25, 0.25, 0.25),
		});
	}
}

function drawQuote(ts: Typesetter, quoteLines: string[]): void {
	beginBlock(ts, "quote");
	const size = ts.opts.fontSize;
	const indent = 14;
	const text = quoteLines.join(" ").trim();
	const lines = wrapText(toWinAnsi(text, ts.opts.typo), ts.italic, size, contentWidth(ts, indent), ts.opts.typo);
	const step = size * ts.opts.lineHeight;
	for (const line of lines) {
		ensureRoom(ts, step);
		ts.y -= step;
		// A drawn quote bar instead of a "|" glyph per line (GP_E5_S7); the
		// per-line segments span the full line step, so consecutive lines
		// join into one continuous bar.
		ts.page.drawLine({
			start: { x: ts.opts.margin + 3, y: ts.y - step * 0.15 },
			end: { x: ts.opts.margin + 3, y: ts.y + step * 0.85 },
			thickness: 1.5,
			color: rgb(0.55, 0.55, 0.55),
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
		let line = toWinAnsi(raw.replace(/\t/g, "  "), ts.opts.typo);
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
				const text = toWinAnsi(row[c] ?? "", ts.opts.typo);
				return text === "" ? 0 : font.widthOfTextAtSize(text, size) + pad;
			}),
		),
	);
	const widths = computeColumnWidths(naturals, total);
	const offsets = widths.map((_, c) => widths.slice(0, c).reduce((a, b) => a + b, 0));

	// Plan every row up front: fill-in shapes (GP_E5_S5), wrapped cell lines
	// and each row's height. The plan feeds the keep-together decision below
	// AND the drawing loop, so the two can never disagree.
	const plans = rows.map((row, rowIndex) => {
		// An all-empty body row is a fill-in row (GP_E5_S5): real writing
		// height and a faint rule — a one-line sliver is useless under a pen.
		const writing =
			ts.opts.typo >= 2 && rowIndex > 0 && row.every((cell) => (cell ?? "").trim() === "");
		if (writing) {
			return { writing, label: false, cellLines: [] as string[][], height: 2.4 * step };
		}
		// A label row — only the first column filled, the rest left to
		// complete on the device — is the other fill-in shape (typo 3+).
		const label =
			ts.opts.typo >= 3 &&
			rowIndex > 0 &&
			row.length > 1 &&
			(row[0] ?? "").trim() !== "" &&
			row.slice(1).every((cell) => (cell ?? "").trim() === "");
		const font = rowIndex === 0 ? ts.bold : ts.body;
		const cellLines = row.map((cell, c) =>
			wrapText(toWinAnsi(cell, ts.opts.typo), font, size, Math.max(widths[c] - pad, 24), ts.opts.typo),
		);
		const rowLines = Math.max(1, ...cellLines.map((lines) => lines.length));
		const height = (label ? Math.max(rowLines, 2.4) : rowLines) * step + (rowIndex === 0 ? 6 : 0);
		return { writing, label, cellLines, height };
	});

	// Keep-together (GP_E6_S5, typo 4): a table that fits on one page but not
	// in the space left moves to a fresh page whole, instead of snapping in
	// two. Taller-than-page tables keep the row-by-row behaviour.
	if (ts.opts.typo >= 4) {
		const tableHeight = plans.reduce((sum, plan) => sum + plan.height, 0);
		if (tableHeight <= ts.opts.pageHeight - 2 * ts.opts.margin) {
			ensureRoom(ts, tableHeight);
		}
	}

	rows.forEach((row, rowIndex) => {
		beginBlock(ts, "table", rowIndex);
		const plan = plans[rowIndex];
		if (plan.writing) {
			ensureRoom(ts, plan.height);
			ts.y -= plan.height;
			ts.page.drawLine({
				start: { x: ts.opts.margin, y: ts.y },
				end: { x: ts.opts.margin + total, y: ts.y },
				thickness: 0.4,
				color: rgb(0.7, 0.7, 0.7),
			});
			return;
		}
		const isLabelRow = plan.label;
		const font = rowIndex === 0 ? ts.bold : ts.body;
		const cellLines = plan.cellLines;
		// The planned height IS the consumed height — one formula, one truth,
		// or ensureRoom(tableHeight) above could reserve a different total
		// than the rows actually use.
		const rowHeight = plan.height;
		// Keep the row on one page when it fits; taller-than-page rows fall
		// back to a mid-row break via the per-line floor guard below.
		ensureRoom(ts, Math.min(rowHeight, ts.opts.pageHeight - 2 * ts.opts.margin));
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
		if (isLabelRow) {
			ts.y = Math.min(ts.y, Math.max(top - rowHeight, ts.opts.margin));
			ts.page.drawLine({
				start: { x: ts.opts.margin, y: ts.y },
				end: { x: ts.opts.margin + total, y: ts.y },
				thickness: 0.4,
				color: rgb(0.7, 0.7, 0.7),
			});
		}
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
		end: { x: ts.opts.pageWidth - ts.opts.margin, y: ts.y },
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
	const opts = resolveLayoutOptions(options);
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

	// A pagebreak is honoured lazily, before the next drawn block: a marker
	// at the very end (or on an already-fresh page) never leaves a blank
	// page behind (GP_E6_S1). Headings up to opts.breakAtHeading get the
	// same treatment (GP_E6_S4) — except the very first block, which would
	// otherwise leave the title alone on a near-empty page.
	let pendingBreak = false;
	let drewContent = false;
	for (const block of blocks) {
		if (block.type === "pagebreak") {
			pendingBreak = true;
			continue;
		}
		const breakForHeading =
			block.type === "heading" &&
			drewContent &&
			block.level >= 1 &&
			block.level <= ts.opts.breakAtHeading;
		if (pendingBreak || breakForHeading) {
			pendingBreak = false;
			if (ts.y < ts.opts.pageHeight - ts.opts.margin) newPage(ts);
		}
		drewContent = true;
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
			pageWidth: ts.opts.pageWidth,
			pageHeight: ts.opts.pageHeight,
			pageCount: ts.pageIndex,
			lines: ts.placed,
			// The RESOLVED version (ts.opts, defaults filled in) — the raw
			// option may be undefined and would misreport what was used.
			typo: ts.opts.typo,
		},
	};
}
