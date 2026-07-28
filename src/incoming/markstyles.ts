/**
 * What a pen mark means (GP_E3_S19).
 *
 * The shapes are fixed — a line through words, a loop around them, a line
 * under them — because that is what a pen can draw and what geometry can
 * recognise. What those shapes *mean* is a personal convention, so the
 * mapping to markdown belongs to the user (owner question, 2026-07-28).
 *
 * Pure data, deliberately outside `settings.ts`: that module reaches into the
 * Obsidian API, and the projection has to stay testable without it.
 */

export type MarkStyle =
	| "strikethrough"
	| "bold"
	| "italic"
	| "underline"
	| "highlight"
	| "none";

/** The three marks whose meaning is configurable. */
export interface MarkStyles {
	strikethrough: MarkStyle;
	circle: MarkStyle;
	underline: MarkStyle;
}

/** What the shapes mean unless the user says otherwise. */
export const DEFAULT_MARK_STYLES: MarkStyles = {
	strikethrough: "strikethrough",
	circle: "bold",
	underline: "underline",
};

/** Labels for the settings dropdown, in the order they are offered. */
export const MARK_STYLE_LABELS: Record<MarkStyle, string> = {
	strikethrough: "Strikethrough",
	bold: "Bold",
	italic: "Italic",
	underline: "Underline",
	highlight: "Highlight",
	none: "Leave the text alone",
};
