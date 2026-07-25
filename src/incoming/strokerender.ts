/**
 * Turning strokes into a readable image (PRD F12; owner decision
 * 2026-07-25: PNG — these are notes to read back, not illustrations).
 *
 * The geometry work is pure and testable here; the actual rasterising
 * needs a canvas, which only exists at the plugin edge. So this module
 * produces a *plan* (canvas size plus polylines in image coordinates) and
 * the edge paints it.
 */

import { Stroke } from "./rmlines";

/** reMarkable page in device units; x is centred on zero. */
export const PAGE_WIDTH = 1404;
export const PAGE_HEIGHT = 1872;

export interface RenderedPath {
	points: { x: number; y: number }[];
	/** Line width in image pixels. */
	width: number;
	/** CSS colour. */
	color: string;
}

export interface RenderPlan {
	width: number;
	height: number;
	paths: RenderedPath[];
}

export interface RenderOptions {
	/** Longest edge of the produced image, in pixels. */
	maxSize?: number;
	/** Blank margin around the ink, in device units. */
	padding?: number;
	/** Crop to the ink instead of rendering the whole page. */
	crop?: boolean;
}

/** reMarkable pen colour indices → what they should look like on paper. */
const COLORS: Record<number, string> = {
	0: "#000000", // black
	1: "#808080", // grey
	2: "#ffffff", // white
	3: "#d4a017", // yellow highlight
	4: "#2e7d32", // green
	5: "#c2185b", // pink
	6: "#1565c0", // blue
	7: "#c62828", // red
	8: "#9e9e9e", // grey overlap
};

export function strokeColor(color: number): string {
	return COLORS[color] ?? "#000000";
}

interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

function boundsOf(strokes: Stroke[]): Bounds | null {
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
 * Lay the strokes out on an image. Cropping to the ink is the default:
 * handwriting usually covers a small part of a page, and a full-page image
 * of mostly white would make the note unreadable at thumbnail size.
 */
export function planRender(strokes: Stroke[], options: RenderOptions = {}): RenderPlan | null {
	const maxSize = options.maxSize ?? 1400;
	const padding = options.padding ?? 40;
	const crop = options.crop ?? true;

	const ink = boundsOf(strokes);
	if (ink === null) return null;

	const area = crop
		? {
				minX: ink.minX - padding,
				minY: ink.minY - padding,
				maxX: ink.maxX + padding,
				maxY: ink.maxY + padding,
			}
		: { minX: -PAGE_WIDTH / 2, minY: 0, maxX: PAGE_WIDTH / 2, maxY: PAGE_HEIGHT };

	const areaWidth = Math.max(area.maxX - area.minX, 1);
	const areaHeight = Math.max(area.maxY - area.minY, 1);
	const scale = Math.min(maxSize / areaWidth, maxSize / areaHeight, 1.5);

	const width = Math.max(Math.round(areaWidth * scale), 1);
	const height = Math.max(Math.round(areaHeight * scale), 1);

	const paths: RenderedPath[] = [];
	for (const stroke of strokes) {
		const points = stroke.points
			.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
			.map((point) => ({
				x: (point.x - area.minX) * scale,
				y: (point.y - area.minY) * scale,
			}));
		if (points.length === 0) continue;
		// Point widths are in device units and vary along the stroke; one
		// representative width per stroke keeps the drawing cheap and even.
		const rawWidth =
			stroke.points.reduce((sum, point) => sum + point.width, 0) / stroke.points.length;
		const width = Math.max(rawWidth * stroke.thicknessScale * scale * 0.02, 1);
		paths.push({ points, width, color: strokeColor(stroke.color) });
	}

	return paths.length > 0 ? { width, height, paths } : null;
}

/** The slice of a 2D canvas context the painter uses; kept tiny for tests. */
export interface PainterContext {
	// Widened to what a real CanvasRenderingContext2D declares, so the edge
	// can pass one straight in without casting.
	lineCap: CanvasLineCap;
	lineJoin: CanvasLineJoin;
	strokeStyle: string | CanvasGradient | CanvasPattern;
	lineWidth: number;
	beginPath(): void;
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	stroke(): void;
	fillStyle: string | CanvasGradient | CanvasPattern;
	fillRect(x: number, y: number, w: number, h: number): void;
}

/** Paint a plan onto a canvas context (white background, then the ink). */
export function paintPlan(context: PainterContext, plan: RenderPlan): void {
	context.fillStyle = "#ffffff";
	context.fillRect(0, 0, plan.width, plan.height);
	context.lineCap = "round";
	context.lineJoin = "round";

	for (const path of plan.paths) {
		context.strokeStyle = path.color;
		context.lineWidth = path.width;
		context.beginPath();
		context.moveTo(path.points[0].x, path.points[0].y);
		for (const point of path.points.slice(1)) context.lineTo(point.x, point.y);
		// A single-point stroke (a dot) would draw nothing without this.
		if (path.points.length === 1) {
			context.lineTo(path.points[0].x + 0.1, path.points[0].y);
		}
		context.stroke();
	}
}
