/**
 * Rendering imported annotations into vault markdown (PRD F11; design:
 * docs/ontwerp-inkomende-route.md §4).
 *
 * Everything the plugin generates lives between markers, so a repeated
 * import replaces only its own output and anything you wrote around it
 * survives — the in-file counterpart of N5.
 */

import { Highlight, colorName } from "./highlights";
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
}

/** Render the generated block (markers included). */
export function renderAnnotationBlock(input: AnnotationRenderInput): string {
	const lines: string[] = [BEGIN_MARKER, ""];
	lines.push(`Annotations from [[${input.sourceName}]], imported ${input.importedAt}.`);
	lines.push("");

	const marks = input.marks ?? [];

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
			const color = colorName(highlight.color);
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
			lines.push(...renderMark(mark), "");
		}
	}

	// Trailing blank line before the end marker keeps the block readable when
	// a user writes directly underneath it.
	if (lines[lines.length - 1] !== "") lines.push("");
	lines.push(END_MARKER);
	return lines.join("\n");
}

/**
 * One annotation as markdown. A recognised mark becomes text you can search
 * and link; only ink whose meaning lives in the ink itself stays a picture
 * (GP_E3_S9).
 */
function renderMark(mark: ImportedMark): string[] {
	const image = mark.path === undefined ? [] : [`![[${mark.path}]]`];
	switch (mark.kind) {
		case "strikethrough":
			return [`~~${mark.target}~~ — struck through`, ...image];
		case "underline":
			return [`<u>${mark.target}</u> — underlined`, ...image];
		case "circle":
			return [`**${mark.target}** — circled`, ...image];
		case "margin":
			return ["Marked in the margin:", `> ${mark.quote}`, ...image];
		case "arrow":
			return [
				mark.targetEnd === undefined
					? `Arrow at: “${mark.target ?? mark.quote ?? ""}”`
					: `Arrow: “${mark.target}” → “${mark.targetEnd}”`,
				...image,
			];
		default:
			return [...(mark.quote === undefined ? [] : [`Note at: “${mark.quote}”`]), ...image];
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
