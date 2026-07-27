/**
 * Reading what a pen mark *means* (PRD K2, GP_E3_S9).
 *
 * A written word carries its meaning in the ink itself. A mark does not: a
 * circle, a strike-through or a margin bar is a *pointer*, and returning the
 * pointer without the thing it points at — which is what a cropped image
 * does — throws the meaning away. Owner feedback 2026-07-26: "de meerwaarde
 * van review op reMarkable is zo nog beperkt".
 *
 * Since the layout map knows where every word sits (GP_E3_S8), the shape and
 * position of a stroke are enough to say what it did — no OCR, no model. A
 * horizontal stroke through the middle of a row struck those words out; a
 * closed loop circled them. That turns ink into searchable markdown.
 */

import { LaidOutLine, PdfLayout } from "../convert/pdf";
import { Bounds, deviceBoundsToPdf, strokeBounds } from "./anchor";
import { Stroke } from "./rmlines";

/**
 * Owner decision 2026-07-26: only four shapes are read. Anything else — an
 * arrow, a scribble, a written word — is a remark at that spot. Guessing at
 * more kinds produced more wrong answers than useful ones.
 */
export type MarkKind = "strikethrough" | "underline" | "circle" | "margin" | "note";

export interface Mark {
	kind: MarkKind;
	/** The words the mark points at. */
	target?: string;
	/** Ids of the words it covers, for weaving into an annotated copy. */
	words?: number[];
	/** Source blocks a margin bar spans. */
	blocks?: number[];
	/** The line(s) around the mark, for context. */
	quote?: string;
	/** Strokes making up this mark, for the kinds that stay an image. */
	strokes: Stroke[];
	/** Device-unit bounds, for rendering. */
	bounds: Bounds;
	/** Vertical position in PDF points, for ordering down the page. */
	orderY: number;
}

/** A row of text: everything placed at one baseline, left to right. */
interface Row {
	y: number;
	size: number;
	lines: LaidOutLine[];
	text: string;
	left: number;
	right: number;
}

function rowsOf(layout: PdfLayout, page: number): Row[] {
	const byBaseline = new Map<number, LaidOutLine[]>();
	for (const line of layout.lines) {
		if (line.page !== page) continue;
		const key = Math.round(line.y * 2) / 2;
		const existing = byBaseline.get(key);
		if (existing === undefined) byBaseline.set(key, [line]);
		else existing.push(line);
	}
	return [...byBaseline.entries()]
		.map(([y, lines]) => {
			const sorted = [...lines].sort((a, b) => a.x - b.x);
			const words = sorted.flatMap((line) => line.words);
			return {
				y,
				size: sorted[0].size,
				lines: sorted,
				text: sorted.map((line) => line.text.trim()).join(" "),
				left: Math.min(...words.map((word) => word.x)),
				right: Math.max(...words.map((word) => word.x + word.width)),
			};
		})
		.sort((a, b) => b.y - a.y);
}

/**
 * The body-text line pitch: the yardstick for every threshold below.
 *
 * Derived from the type size rather than measured between baselines, because
 * paragraph gaps and headings inflate the spacing while the size of the text
 * a mark sits on is exactly what the thresholds are about.
 */
function lineStepOf(rows: Row[]): number {
	if (rows.length === 0) return 16.5;
	const sizes = rows.map((row) => row.size).sort((a, b) => a - b);
	return sizes[Math.floor(sizes.length / 2)] * 1.5;
}

function pathLength(stroke: Stroke): number {
	let total = 0;
	for (let i = 1; i < stroke.points.length; i++) {
		const dx = stroke.points[i].x - stroke.points[i - 1].x;
		const dy = stroke.points[i].y - stroke.points[i - 1].y;
		total += Math.hypot(dx, dy);
	}
	return total;
}

/** Endpoints nearly meeting means the pen came back to where it started. */
function isClosed(stroke: Stroke, bounds: Bounds): boolean {
	const points = stroke.points;
	if (points.length < 8) return false;
	const first = points[0];
	const last = points[points.length - 1];
	const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
	return span > 0 && Math.hypot(last.x - first.x, last.y - first.y) < span * 0.4;
}

/** Indices where the pen turns sharper than 120° — the corners of a shape. */
function sharpTurns(stroke: Stroke): number[] {
	const points = stroke.points;
	const turns: number[] = [];
	for (let i = 2; i < points.length - 2; i++) {
		const ax = points[i].x - points[i - 2].x;
		const ay = points[i].y - points[i - 2].y;
		const bx = points[i + 2].x - points[i].x;
		const by = points[i + 2].y - points[i].y;
		const lenA = Math.hypot(ax, ay);
		const lenB = Math.hypot(bx, by);
		if (lenA < 2 || lenB < 2) continue;
		if ((ax * bx + ay * by) / (lenA * lenB) < -0.5) {
			// One corner spans a few samples; count it once.
			if (turns.length === 0 || i - turns[turns.length - 1] > 3) turns.push(i);
		}
	}
	return turns;
}

/** How far a stroke strays from the straight line between its endpoints. */
function straightness(stroke: Stroke, length: number): number {
	const first = stroke.points[0];
	const last = stroke.points[stroke.points.length - 1];
	const direct = Math.hypot(last.x - first.x, last.y - first.y);
	return direct < 1 ? Infinity : length / direct;
}

/**
 * Vertical overlap between a row's band and a piece of ink. A perfectly flat
 * stroke has no height of its own, so the ink is given a hair's thickness —
 * otherwise the most common mark of all would never match a row.
 */
function bandOverlap(row: Row, ink: Bounds): number {
	const low = row.y - row.size * 0.3;
	const high = row.y + row.size * 0.85;
	return Math.min(high, ink.maxY + 0.5) - Math.max(low, ink.minY - 0.5);
}

/** The row a mark belongs to: the one its vertical span overlaps most. */
function rowFor(rows: Row[], ink: Bounds): Row | undefined {
	let best: { row: Row; overlap: number } | undefined;
	for (const row of rows) {
		const overlap = bandOverlap(row, ink);
		if (overlap > 0 && (best === undefined || overlap > best.overlap)) {
			best = { row, overlap };
		}
	}
	return best?.row;
}

/** Words of a row whose span the ink covers, in reading order. */
function wordsUnder(row: Row, minX: number, maxX: number) {
	return row.lines
		.flatMap((line) => line.words)
		.filter((word) => {
			const overlap = Math.min(maxX, word.x + word.width) - Math.max(minX, word.x);
			// Two-fifths of a word is enough: people rarely strike a phrase
			// exactly from first pixel to last.
			return overlap > 0 && overlap >= word.width * 0.4;
		})
		.sort((a, b) => a.x - b.x);
}

/** Rows a mark spans vertically, for a margin bar. */
function rowsBeside(rows: Row[], ink: Bounds): Row[] {
	return rows.filter((row) => bandOverlap(row, ink) > 0);
}

interface Candidate {
	stroke: Stroke;
	device: Bounds;
	pdf: Bounds;
	length: number;
}

/**
 * Read a page's ink. Strokes that describe a mark come back typed and with
 * the words they point at; the rest is grouped into handwritten notes, which
 * stay images.
 */
export function readMarks(
	strokes: Stroke[],
	page: number,
	layout: PdfLayout | null,
	noteGap = 90,
): Mark[] {
	const candidates: Candidate[] = [];
	for (const stroke of strokes) {
		const device = strokeBounds([stroke]);
		if (device === null) continue;
		candidates.push({
			stroke,
			device,
			pdf: layout === null ? device : deviceBoundsToPdf(device, layout),
			length: pathLength(stroke),
		});
	}
	if (candidates.length === 0) return [];

	const rows = layout === null ? [] : rowsOf(layout, page);
	const marks: Mark[] = [];
	const leftovers: Candidate[] = [];

	if (rows.length > 0) {
		const step = lineStepOf(rows);
		const textLeft = Math.min(...rows.map((row) => row.left));
		const textRight = Math.max(...rows.map((row) => row.right));
		// The device grid is ~3.14× the PDF grid, so lengths measured in
		// device units need the same scale before comparing to a line step.
		const scale = layout === null ? 1 : layout.pageHeight / 1872;

		for (const candidate of candidates) {
			const mark = classify(candidate, rows, step, textLeft, textRight, scale);
			if (mark === null) leftovers.push(candidate);
			else marks.push(mark);
		}
	} else {
		leftovers.push(...candidates);
	}

	marks.push(...groupNotes(leftovers, rows, noteGap));
	return marks.sort((a, b) => b.orderY - a.orderY);
}

function classify(
	candidate: Candidate,
	rows: Row[],
	step: number,
	textLeft: number,
	textRight: number,
	scale: number,
): Mark | null {
	const { pdf, device, stroke } = candidate;
	const width = pdf.maxX - pdf.minX;
	const height = pdf.maxY - pdf.minY;
	const length = candidate.length * scale;
	const base = { strokes: [stroke], bounds: device, orderY: pdf.maxY };

	// Smaller than a line: that is a pen stroke inside a letter, not a mark.
	if (Math.hypot(width, height) < step * 0.8) return null;

	// A bar in the margin: tall, narrow, straight, outside the text column,
	// and without a corner. The corner test matters: an arrow drawn down the
	// margin is tall, narrow and near enough to straight, and used to be
	// reported as a plain margin mark (beta, 2026-07-26).
	if (
		height >= step * 0.8 &&
		width <= step * 0.8 &&
		straightness(stroke, length) < 1.4 &&
		sharpTurns(stroke).length === 0 &&
		(pdf.maxX < textLeft || pdf.minX > textRight)
	) {
		const beside = rowsBeside(rows, pdf);
		if (beside.length > 0) {
			return {
				...base,
				kind: "margin",
				quote: beside.map((row) => row.text).join(" "),
			};
		}
	}

	// A flat, wide stroke over a row: struck through or underlined, depending
	// on where it crosses that row. Tested before the arrow, because a zigzag
	// strike-through turns sharply too.
	if (height <= step * 0.55 && width >= step * 2) {
		const row = rowFor(rows, pdf);
		if (row !== undefined) {
			const covered = wordsUnder(row, pdf.minX, pdf.maxX);
			if (covered.length > 0) {
				const middle = (pdf.minY + pdf.maxY) / 2;
				const throughText = middle > row.y + row.size * 0.15;
				return {
					...base,
					kind: throughText ? "strikethrough" : "underline",
					target: covered.map((word) => word.text).join(" "),
					words: covered.map((word) => word.id),
					quote: row.text,
				};
			}
		}
	}

	// A loop around words.
	if (isClosed(stroke, device) && width >= step && height >= step * 0.6) {
		const row = rowFor(rows, pdf);
		if (row !== undefined) {
			const covered = wordsUnder(row, pdf.minX, pdf.maxX);
			if (covered.length > 0) {
				return {
					...base,
					kind: "circle",
					target: covered.map((word) => word.text).join(" "),
					words: covered.map((word) => word.id),
					quote: row.text,
				};
			}
		}
	}

	return null;
}

/** Unclassified ink is handwriting: group it per remark and keep the image. */
function groupNotes(leftovers: Candidate[], rows: Row[], gap: number): Mark[] {
	const sorted = [...leftovers].sort((a, b) => a.device.minY - b.device.minY);
	const groups: { mark: Mark; pdf: Bounds }[] = [];
	for (const candidate of sorted) {
		const last = groups[groups.length - 1];
		if (last !== undefined && candidate.device.minY <= last.mark.bounds.maxY + gap) {
			last.mark.strokes.push(candidate.stroke);
			last.mark.bounds = merge(last.mark.bounds, candidate.device);
			last.pdf = merge(last.pdf, candidate.pdf);
			last.mark.orderY = last.pdf.maxY;
			continue;
		}
		groups.push({
			mark: {
				kind: "note",
				strokes: [candidate.stroke],
				bounds: { ...candidate.device },
				orderY: candidate.pdf.maxY,
			},
			pdf: { ...candidate.pdf },
		});
	}
	// Quote each note once its full extent is known: the row it overlaps, or
	// the nearest one above — where a remark written under a line points.
	for (const group of groups) {
		const row = rowFor(rows, group.pdf) ?? nearestRow(rows, group.pdf);
		if (row !== undefined) group.mark.quote = row.text;
	}
	return groups.map((group) => group.mark);
}

function merge(a: Bounds, b: Bounds): Bounds {
	return {
		minX: Math.min(a.minX, b.minX),
		minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX),
		maxY: Math.max(a.maxY, b.maxY),
	};
}

/** Closest row within about two lines; beyond that there is nothing to say. */
function nearestRow(rows: Row[], ink: Bounds): Row | undefined {
	let best: { row: Row; distance: number } | undefined;
	for (const row of rows) {
		const distance = Math.max(0, Math.max(row.y - ink.maxY, ink.minY - row.y));
		if (best === undefined || distance < best.distance) best = { row, distance };
	}
	if (best === undefined) return undefined;
	return best.distance <= (best.row.size ?? 11) * 3 ? best.row : undefined;
}
