/**
 * Parsing reMarkable highlight files (PRD F11; design:
 * docs/ontwerp-inkomende-route.md §1).
 *
 * A document carries one JSON file per annotated page under
 * `<doc>.highlights/<page>.json`, shaped `{"highlights": [[{...}]]}` — a
 * list of layers, each a list of highlights. The format is undocumented and
 * firmware-dependent, so this parser is deliberately tolerant: it accepts
 * nested or flat lists, skips entries without text (a highlight over an
 * image has rects but no text), and never throws on unknown fields.
 */

export interface Highlight {
	text: string;
	/** reMarkable colour index; 0-2 on older firmware, 3-5 since 2.12. */
	color?: number;
	/** Page this highlight belongs to, in document order (1-based). */
	page?: number;
}

/** reMarkable colour indices seen in the wild, mapped to readable names. */
const COLOR_NAMES: Record<number, string> = {
	0: "yellow",
	1: "blue",
	2: "pink",
	3: "yellow",
	4: "blue",
	5: "pink",
	6: "orange",
	7: "green",
	8: "grey",
};

export function colorName(color: number | undefined): string | undefined {
	return color === undefined ? undefined : COLOR_NAMES[color];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readHighlight(candidate: unknown): Highlight | null {
	if (!isRecord(candidate)) return null;
	const text = candidate.text;
	if (typeof text !== "string") return null;
	const trimmed = text.trim();
	if (trimmed === "") return null;
	const color = candidate.color;
	return {
		text: trimmed,
		...(typeof color === "number" ? { color } : {}),
	};
}

/**
 * Parse one page's highlight JSON. Returns [] for anything unparseable —
 * a broken page must never sink the whole import (N3).
 */
export function parseHighlightPage(json: string, page?: number): Highlight[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	const container = isRecord(parsed) ? parsed.highlights : undefined;
	if (!Array.isArray(container)) return [];

	const out: Highlight[] = [];
	for (const layer of container) {
		// Nested (list of layers) or flat (list of highlights) — accept both.
		const items = Array.isArray(layer) ? layer : [layer];
		for (const item of items) {
			const highlight = readHighlight(item);
			if (highlight) out.push(page === undefined ? highlight : { ...highlight, page });
		}
	}
	return out;
}

/** Path of a highlight file inside a document: `<doc>.highlights/<page>.json`. */
export function isHighlightFile(path: string): boolean {
	return /\.highlights\/[^/]+\.json$/.test(path);
}

/** Page id from a highlight file path, for ordering against `.content`. */
export function pageIdFromHighlightPath(path: string): string | null {
	const match = path.match(/\.highlights\/([^/]+)\.json$/);
	return match ? match[1] : null;
}
