/**
 * How the device was showing the page when the ink was written (GP_E3_S15).
 *
 * Beta finding 2026-07-27: pen marks land about three text rows too low,
 * while their horizontal position is exact and text highlights — which are
 * placed by their own text, not by geometry — are perfect. Measured against
 * the owner's own document the error is a *constant* 55.5 pt downward, the
 * same at the top of the page as two thirds down. Constant, not proportional,
 * means the scale is right and the origin is not: the ink is recorded against
 * a view of the page, not against the page.
 *
 * `.content` is where the reMarkable records that view. The exact field names
 * differ per firmware, so nothing is assumed here: every candidate is read
 * and reported, and the correction is applied only for values whose meaning
 * is established. An unreadable or unknown view costs the correction, not the
 * import (N3).
 */

/** View fields as found in `.content`; all optional, all firmware-dependent. */
export interface PageView {
	/** e.g. "bestFit", "customFit", "fitToWidth" — the device's own wording. */
	zoomMode?: string;
	scale?: number;
	centerX?: number;
	centerY?: number;
	pageWidth?: number;
	pageHeight?: number;
	/** Page transform matrix, when the document carries one. */
	transform?: Record<string, number>;
	/** Every other numeric field whose name hints at the view, for diagnosis. */
	extra: Record<string, number | string>;
}

const NUMERIC_KEYS: Record<string, keyof PageView> = {
	customZoomScale: "scale",
	customZoomCenterX: "centerX",
	customZoomCenterY: "centerY",
	customZoomPageWidth: "pageWidth",
	customZoomPageHeight: "pageHeight",
};

/** Names that plausibly describe the view; reported even when unrecognised. */
const HINTS = ["zoom", "fit", "crop", "margin", "offset", "scale", "orientation", "rotation"];

/**
 * The view fields of a `.content` document. Returns null when the file cannot
 * be read at all — the caller keeps importing either way.
 */
export function parsePageView(contentJson: string): PageView | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(contentJson);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const root = parsed as Record<string, unknown>;

	const view: PageView = { extra: {} };
	if (typeof root.zoomMode === "string") view.zoomMode = root.zoomMode;
	for (const [key, field] of Object.entries(NUMERIC_KEYS)) {
		const value = root[key];
		if (typeof value === "number") (view[field] as number) = value;
	}
	if (typeof root.transform === "object" && root.transform !== null) {
		const matrix: Record<string, number> = {};
		for (const [key, value] of Object.entries(root.transform as Record<string, unknown>)) {
			if (typeof value === "number") matrix[key] = value;
		}
		if (Object.keys(matrix).length > 0) view.transform = matrix;
	}
	for (const [key, value] of Object.entries(root)) {
		if (key in NUMERIC_KEYS || key === "zoomMode" || key === "transform") continue;
		if (typeof value !== "number" && typeof value !== "string") continue;
		const lower = key.toLowerCase();
		if (HINTS.some((hint) => lower.includes(hint))) view.extra[key] = value;
	}
	return view;
}

/** One line for the import report; empty when the document says nothing. */
export function describePageView(view: PageView | null): string {
	if (view === null) return "";
	const parts: string[] = [];
	if (view.zoomMode !== undefined) parts.push(`mode ${view.zoomMode}`);
	if (view.scale !== undefined) parts.push(`scale ${view.scale}`);
	if (view.centerX !== undefined || view.centerY !== undefined) {
		parts.push(`center ${view.centerX ?? "?"},${view.centerY ?? "?"}`);
	}
	if (view.pageWidth !== undefined || view.pageHeight !== undefined) {
		parts.push(`page ${view.pageWidth ?? "?"}×${view.pageHeight ?? "?"}`);
	}
	if (view.transform !== undefined) {
		const matrix = Object.entries(view.transform)
			.map(([key, value]) => `${key}=${value}`)
			.join(" ");
		parts.push(`transform ${matrix}`);
	}
	for (const [key, value] of Object.entries(view.extra)) parts.push(`${key}=${value}`);
	return parts.join(", ");
}
