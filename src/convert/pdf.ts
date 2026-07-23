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

// reMarkable 2 screen in PDF points (1404×1872 px at 226 DPI).
export const PAGE_WIDTH = 447;
export const PAGE_HEIGHT = 596;

const DEFAULTS: Required<PdfLayoutOptions> = {
	fontSize: 11,
	lineHeight: 1.5,
	margin: 40,
};

const HEADING_SIZES: Record<number, number> = { 1: 19, 2: 16, 3: 14, 4: 12, 5: 11, 6: 11 };

/** Replace characters WinAnsi cannot encode with a readable ASCII fallback. */
export function toWinAnsi(text: string): string {
	const replacements: Record<string, string> = {
		"→": "->", "←": "<-", "↔": "<->",
		"–": "-", "—": "--",
		"‘": "'", "’": "'", "“": '"', "”": '"',
		"…": "...", " ": " ", "•": "-", "′": "'", "″": '"',
		"≤": "<=", "≥": ">=", "≠": "!=", "≈": "~",
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
	y: number;
	body: PDFFont;
	bold: PDFFont;
	italic: PDFFont;
	mono: PDFFont;
	opts: Required<PdfLayoutOptions>;
}

function newPage(ts: Typesetter): void {
	ts.page = ts.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
	ts.y = PAGE_HEIGHT - ts.opts.margin;
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
		ts.page.drawText(line, {
			x: ts.opts.margin + indent,
			y: ts.y,
			size,
			font,
			color: rgb(0, 0, 0),
		});
	}
	ts.y -= extraGapAfter;
}

function contentWidth(ts: Typesetter, indent = 0): number {
	return PAGE_WIDTH - 2 * ts.opts.margin - indent;
}

function drawHeading(ts: Typesetter, level: number, text: string): void {
	const size = HEADING_SIZES[level] ?? 11;
	const gapBefore = size * 0.8;
	ensureRoom(ts, gapBefore + size * ts.opts.lineHeight);
	ts.y -= gapBefore;
	const lines = wrapText(toWinAnsi(text), ts.bold, size, contentWidth(ts));
	drawLines(ts, lines, ts.bold, size, 0, size * 0.35);
}

function drawParagraph(ts: Typesetter, text: string): void {
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

		const indent = 14 + item.depth * 14;
		const bullet = item.ordered ? `${counters[item.depth]}.` : "-";
		const lines = wrapText(toWinAnsi(item.text), ts.body, size, contentWidth(ts, indent));
		const step = size * ts.opts.lineHeight;
		ensureRoom(ts, step);
		// Bullet on the first line, hanging indent for wrapped lines.
		ts.y -= step;
		ts.page.drawText(bullet, { x: ts.opts.margin + indent - 12, y: ts.y, size, font: ts.body });
		if (lines.length > 0) {
			ts.page.drawText(lines[0], { x: ts.opts.margin + indent, y: ts.y, size, font: ts.body });
		}
		for (const line of lines.slice(1)) {
			ensureRoom(ts, step);
			ts.y -= step;
			ts.page.drawText(line, { x: ts.opts.margin + indent, y: ts.y, size, font: ts.body });
		}
	}
	ts.y -= size * 0.6;
}

function drawQuote(ts: Typesetter, quoteLines: string[]): void {
	const size = ts.opts.fontSize;
	const indent = 14;
	const text = quoteLines.join(" ").trim();
	const lines = wrapText(toWinAnsi(text), ts.italic, size, contentWidth(ts, indent));
	const step = size * ts.opts.lineHeight;
	for (const line of lines) {
		ensureRoom(ts, step);
		ts.y -= step;
		ts.page.drawText("|", { x: ts.opts.margin + 2, y: ts.y, size, font: ts.body });
		ts.page.drawText(line, { x: ts.opts.margin + indent, y: ts.y, size, font: ts.italic });
	}
	ts.y -= size * 0.6;
}

function drawCode(ts: Typesetter, codeLines: string[]): void {
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
		ts.page.drawText(line, { x: ts.opts.margin + 8, y: ts.y, size, font: ts.mono });
	}
	ts.y -= size * 0.8;
}

function drawTable(ts: Typesetter, rows: string[][]): void {
	// Simple fixed-grid rendering: equal column widths, truncated cells.
	const size = ts.opts.fontSize - 1;
	const cols = Math.max(...rows.map((r) => r.length), 1);
	const colWidth = contentWidth(ts) / cols;
	const step = size * ts.opts.lineHeight;
	rows.forEach((row, rowIndex) => {
		ensureRoom(ts, step);
		ts.y -= step;
		const font = rowIndex === 0 ? ts.bold : ts.body;
		row.forEach((cell, col) => {
			let text = toWinAnsi(cell);
			while (text.length > 0 && font.widthOfTextAtSize(text, size) > colWidth - 6) {
				text = text.slice(0, -1);
			}
			ts.page.drawText(text, { x: ts.opts.margin + col * colWidth, y: ts.y, size, font });
		});
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

/**
 * Render blocks to PDF bytes. The note title becomes an H1-style document
 * header; the document ID lands in the PDF Subject for round-trip detection.
 */
export async function renderPdf(
	blocks: Block[],
	meta: PdfMetadata,
	options: PdfLayoutOptions = {},
): Promise<Uint8Array> {
	const opts = { ...DEFAULTS, ...options };
	const doc = await PDFDocument.create();
	doc.setTitle(meta.title);
	doc.setSubject(`${DOCID_SUBJECT_PREFIX}${meta.docId}`);
	doc.setCreator("reMarkable Round-Trip (Obsidian plugin)");

	const ts: Typesetter = {
		doc,
		page: undefined as unknown as PDFPage,
		y: 0,
		body: await doc.embedFont(StandardFonts.Helvetica),
		bold: await doc.embedFont(StandardFonts.HelveticaBold),
		italic: await doc.embedFont(StandardFonts.HelveticaOblique),
		mono: await doc.embedFont(StandardFonts.Courier),
		opts,
	};
	newPage(ts);

	drawHeading(ts, 1, meta.title);
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

	return doc.save();
}
