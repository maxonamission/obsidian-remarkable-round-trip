/**
 * Anchoring handwriting to the text it comments on (PRD K2, GP_E3_S8).
 *
 * The device hands back strokes in page coordinates and nothing else — the
 * PDF's text layer is never merged into them. But *we* typeset that PDF, so
 * we know which sentence sits at which height on which page. Projecting the
 * ink onto that layout turns "a drawing on page 3" into "the remark next to
 * this sentence", which is the whole point of the round-trip.
 *
 * Pure geometry: no PDF rasterising, so it runs on mobile (N7).
 */

import { LaidOutLine, PdfLayout } from "../convert/pdf";
import { Stroke } from "./rmlines";
import { deviceGridFor } from "./strokerender";

export interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** Ink belonging together: one remark, to be rendered and quoted as a unit. */
export interface InkCluster {
	strokes: Stroke[];
	/** Bounds in device units. */
	bounds: Bounds;
}

/** Bounds of a set of strokes in device units, or null when there is no ink. */
export function strokeBounds(strokes: Stroke[]): Bounds | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const stroke of strokes) {
		for (const point of stroke.points) {
			if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
			minX = Math.min(minX, point.x);
			minY = Math.min(minY, point.y);
			maxX = Math.max(maxX, point.x);
			maxY = Math.max(maxY, point.y);
		}
	}
	return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Split a page's ink into remarks by vertical gaps. A note beside the second
 * paragraph and an underline in the fifth are separate thoughts and deserve
 * separate images with separate quotes; lines of one handwritten sentence sit
 * far closer together than that.
 *
 * Vertical only: text flows in lines, so horizontal position says little
 * about which remark ink belongs to — a margin note and the underline it
 * refers to share a height, not a column.
 */
export function clusterStrokes(strokes: Stroke[], gap = 90): InkCluster[] {
	const measured = strokes
		.map((stroke) => ({ stroke, bounds: strokeBounds([stroke]) }))
		.filter((entry): entry is { stroke: Stroke; bounds: Bounds } => entry.bounds !== null)
		.sort((a, b) => a.bounds.minY - b.bounds.minY);

	const clusters: InkCluster[] = [];
	for (const { stroke, bounds } of measured) {
		const last = clusters[clusters.length - 1];
		if (last !== undefined && bounds.minY <= last.bounds.maxY + gap) {
			last.strokes.push(stroke);
			last.bounds = {
				minX: Math.min(last.bounds.minX, bounds.minX),
				minY: Math.min(last.bounds.minY, bounds.minY),
				maxX: Math.max(last.bounds.maxX, bounds.maxX),
				maxY: Math.max(last.bounds.maxY, bounds.maxY),
			};
		} else {
			clusters.push({ strokes: [stroke], bounds: { ...bounds } });
		}
	}
	return clusters;
}

/**
 * Device page coordinates → PDF points. The device grid (x centred on zero,
 * y downwards) maps 1:1 onto our page size, which is exactly why the PDF is
 * typeset on it (K1). Which grid that is depends on the device the page was
 * sent to — the layout's page size tells (see deviceGridFor).
 */
export function deviceBoundsToPdf(bounds: Bounds, layout: PdfLayout): Bounds {
	const grid = deviceGridFor(layout);
	const scaleX = layout.pageWidth / grid.width;
	const scaleY = layout.pageHeight / grid.height;
	return {
		minX: (bounds.minX + grid.width / 2) * scaleX,
		maxX: (bounds.maxX + grid.width / 2) * scaleX,
		// PDF y grows upwards, device y downwards: the extremes swap.
		minY: layout.pageHeight - bounds.maxY * scaleY,
		maxY: layout.pageHeight - bounds.minY * scaleY,
	};
}

/** One device point → PDF points, the same mapping as deviceBoundsToPdf. */
export function devicePointToPdf(
	point: { x: number; y: number },
	layout: PdfLayout,
): { x: number; y: number } {
	const grid = deviceGridFor(layout);
	return {
		x: (point.x + grid.width / 2) * (layout.pageWidth / grid.width),
		y: layout.pageHeight - point.y * (layout.pageHeight / grid.height),
	};
}

/** Vertical band a laid-out line occupies, baseline plus ascender/descender. */
function bandOf(line: LaidOutLine): { low: number; high: number } {
	return { low: line.y - line.size * 0.3, high: line.y + line.size * 0.85 };
}

/** Lines placed at the same baseline, joined left to right. */
function joinRow(lines: LaidOutLine[]): string {
	return [...lines]
		.sort((a, b) => a.x - b.x)
		.map((line) => line.text.trim())
		.filter((text) => text !== "")
		.join(" ");
}

export interface QuoteOptions {
	/** How far beyond the ink to look, as a multiple of the line height. */
	tolerance?: number;
	maxLines?: number;
	maxChars?: number;
}

/**
 * The text a piece of ink sits against, or undefined when nothing is close
 * enough. Undefined is a legitimate answer: a remark in an empty margin has
 * no sentence to quote, and inventing one would mislead.
 */
export function quoteForInk(
	deviceBounds: Bounds,
	page: number,
	layout: PdfLayout,
	options: QuoteOptions = {},
): string | undefined {
	const maxLines = options.maxLines ?? 3;
	const maxChars = options.maxChars ?? 300;

	const onPage = layout.lines.filter((line) => line.page === page);
	if (onPage.length === 0) return undefined;

	const ink = deviceBoundsToPdf(deviceBounds, layout);
	const typicalSize = onPage[0].size;
	const tolerance = (options.tolerance ?? 1) * typicalSize * 1.5;

	// Rows first: a table row or a bullet is several placements at one
	// baseline, and quoting half of it would read as a broken sentence.
	const rows = new Map<number, LaidOutLine[]>();
	for (const line of onPage) {
		const key = Math.round(line.y * 2) / 2;
		const row = rows.get(key);
		if (row === undefined) rows.set(key, [line]);
		else row.push(line);
	}

	const candidates = [...rows.entries()]
		.map(([y, lines]) => ({ y, lines, band: bandOf(lines[0]) }))
		.map((row) => ({
			...row,
			// Distance from the ink's own vertical span; zero when they overlap.
			distance: Math.max(0, Math.max(row.band.low - ink.maxY, ink.minY - row.band.high)),
		}))
		.filter((row) => row.distance <= tolerance)
		.sort((a, b) => b.y - a.y);

	if (candidates.length === 0) return undefined;

	const overlapping = candidates.filter((row) => row.distance === 0);
	// Nothing overlaps: fall back to the single nearest line, which is what a
	// note written under or beside a sentence points at.
	const chosen =
		overlapping.length > 0
			? overlapping
			: [candidates.reduce((best, row) => (row.distance < best.distance ? row : best))];

	const texts = chosen.slice(0, maxLines).map((row) => joinRow(row.lines));
	const quote = texts.join(" ").replace(/\s+/g, " ").trim();
	if (quote === "") return undefined;
	if (quote.length <= maxChars) return quote;
	return `${quote.slice(0, maxChars).trimEnd()}…`;
}
