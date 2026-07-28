/**
 * Rendering imported annotations into vault markdown (PRD F11; design:
 * docs/ontwerp-inkomende-route.md §4).
 *
 * Everything the plugin generates lives between markers, so a repeated
 * import replaces only its own output and anything you wrote around it
 * survives — the in-file counterpart of N5.
 */

import type { PdfLayout } from "../convert/pdf";
import { projectOntoSource } from "./sourceprojection";
import { Highlight, colorName, rgbName } from "./highlights";
import { DEFAULT_MARK_STYLES, MarkStyles } from "./markstyles";
import type { ImportedMark } from "./pull";

export const BEGIN_MARKER = "<!-- remarkable-round-trip:begin -->";
export const END_MARKER = "<!-- remarkable-round-trip:end -->";

export interface AnnotationRenderInput {
	/** Vault path of the source note, for the backlink. */
	sourcePath: string;
	/** Basename of the source note, used as link text. */
	sourceName: string;
	highlights: Highlight[];
	/** Pen annotations, in document order (F12, GP_E3_S8/S9). */
	marks?: ImportedMark[];
	/** ISO timestamp of this import. */
	importedAt: string;
	/**
	 * Page layout of the document as it was sent. With it the block becomes an
	 * annotated copy of the whole text; without it, a list of annotations
	 * (GP_E3_S12).
	 */
	layout?: PdfLayout | null;
	/** The note as it is on disk, frontmatter removed (GP_E3_S13). */
	source?: string | null;
	/**
	 * Writing into the source note itself must stay a summary — a full copy
	 * there would double the note.
	 */
	inSourceNote?: boolean;
	/**
	 * The note was edited after this document was sent, so these annotations
	 * belong to the earlier version. Said out loud in the block instead of
	 * assumed away (F14, N5).
	 */
	sourceChanged?: boolean;
	/** How each recognised mark is written; defaults when not given. */
	styles?: MarkStyles;
}

/** How the block came out, so the report can say so (GP_E3_S14). */
export interface AnnotationOutcome {
	form: "copy" | "summary";
	/** Why a copy was not possible. */
	reason?: "no-layout" | "no-source" | "in-source-note" | "no-alignment";
	/** Highlights whose text could not be located in the note. */
	unplaced?: number;
}

export interface RenderedAnnotations {
	text: string;
	outcome: AnnotationOutcome;
}

/** Render the generated block (markers included). */
export function renderAnnotationBlock(input: AnnotationRenderInput): RenderedAnnotations {
	const lines: string[] = [BEGIN_MARKER, ""];
	lines.push(`Annotations from [[${input.sourceName}]], imported ${input.importedAt}.`);
	lines.push("");
	if (input.sourceChanged === true) {
		lines.push(
			"> [!warning] The note changed after this document was sent",
			"> These annotations belong to the version that went to the reMarkable, not to the",
			"> note as it reads now. Send the note again to annotate the current version.",
			"",
		);
	}

	const marks = input.marks ?? [];

	const copy =
		input.layout && input.source && input.inSourceNote !== true
			? projectOntoSource({
					source: input.source,
					layout: input.layout,
					highlights: input.highlights,
					marks,
					styles: input.styles,
				})
			: null;
	if (copy !== null) {
		lines.push(copy.markdown, "");
		if (lines[lines.length - 1] !== "") lines.push("");
		lines.push(END_MARKER);
		return {
			text: lines.join("\n"),
			outcome: { form: "copy", unplaced: copy.unplaced.length },
		};
	}

	if (input.highlights.length === 0 && marks.length === 0) {
		lines.push("_No text highlights or pen marks found in this document._");
	} else if (input.highlights.length === 0) {
		lines.push("_No text highlights; the pen marks are below._");
	} else {
		let currentPage: number | undefined;
		for (const highlight of input.highlights) {
			if (highlight.page !== undefined && highlight.page !== currentPage) {
				currentPage = highlight.page;
				lines.push(`### Page ${currentPage}`, "");
			}
			const color = rgbName(highlight.rgb) ?? colorName(highlight.color);
			const suffix = color === undefined ? "" : ` ^[${color}]`;
			lines.push(`> ${highlight.text}${suffix}`, "");
		}
	}

	if (marks.length > 0) {
		lines.push("", "### Pen marks", "");
		let currentPage: number | undefined;
		let first = true;
		for (const mark of marks) {
			if (mark.page !== currentPage || first) {
				currentPage = mark.page;
				lines.push(mark.page === undefined ? "**Page unknown**" : `**Page ${mark.page}**`, "");
				first = false;
			}
			lines.push(...renderMark(mark, input.styles ?? DEFAULT_MARK_STYLES), "");
		}
	}

	// Trailing blank line before the end marker keeps the block readable when
	// a user writes directly underneath it.
	if (lines[lines.length - 1] !== "") lines.push("");
	lines.push(END_MARKER);
	return {
		text: lines.join("\n"),
		outcome: { form: "summary", reason: fallbackReason(input) },
	};
}

/** Why the annotated copy was not possible — the report says this out loud. */
function fallbackReason(input: AnnotationRenderInput): AnnotationOutcome["reason"] {
	if (input.inSourceNote === true) return "in-source-note";
	if (!input.layout) return "no-layout";
	if (!input.source) return "no-source";
	return "no-alignment";
}

/**
 * One annotation as markdown. A recognised mark becomes text you can search
 * and link; only ink whose meaning lives in the ink itself stays a picture
 * (GP_E3_S9).
 */
function renderMark(mark: ImportedMark, styles: MarkStyles): string[] {
	const image = mark.path === undefined ? [] : [`![[${mark.path}]]`];
	// The summary form names the gesture; the styling follows the same
	// setting as the annotated copy so the two never disagree (GP_E3_S19).
	const styled = (kind: keyof MarkStyles, label: string): string[] => {
		const [open, close] = markupFor(styles[kind]);
		return [`${open}${mark.target}${close} — ${label}`, ...image];
	};
	switch (mark.kind) {
		case "strikethrough":
			return styled("strikethrough", "struck through");
		case "underline":
			return styled("underline", "underlined");
		case "circle":
			return styled("circle", "circled");
		case "margin":
			return ["Marked in the margin:", `> ${mark.quote}`, ...image];
		default:
			return [...(mark.quote === undefined ? [] : [`Note at: “${mark.quote}”`]), ...image];
	}
}

/** Inline markup for a style, for the summary form. */
function markupFor(style: MarkStyles[keyof MarkStyles]): [string, string] {
	switch (style) {
		case "strikethrough":
			return ["~~", "~~"];
		case "bold":
			return ["**", "**"];
		case "italic":
			return ["*", "*"];
		case "underline":
			return ["<u>", "</u>"];
		case "highlight":
			return ["==", "=="];
		default:
			return ["", ""];
	}
}

/**
 * Insert or replace the generated block in an existing document. Content
 * outside the markers is preserved verbatim; an unmarked file gets the
 * block appended.
 */
export function upsertAnnotationBlock(existing: string, block: string): string {
	const start = existing.indexOf(BEGIN_MARKER);
	const end = existing.indexOf(END_MARKER);
	if (start !== -1 && end !== -1 && end > start) {
		const before = existing.slice(0, start);
		const after = existing.slice(end + END_MARKER.length);
		return `${before}${block}${after}`;
	}
	if (existing.trim() === "") return `${block}\n`;
	const separator = existing.endsWith("\n") ? "\n" : "\n\n";
	return `${existing}${separator}${block}\n`;
}

/** Default vault path for a source note's companion annotation note. */
export function companionPath(sourcePath: string, folder: string): string {
	const name = sourcePath.split("/").pop() ?? sourcePath;
	const base = name.replace(/\.md$/i, "");
	const cleanFolder = folder.replace(/^\/+|\/+$/g, "");
	const fileName = `${base} — annotations.md`;
	return cleanFolder === "" ? fileName : `${cleanFolder}/${fileName}`;
}
