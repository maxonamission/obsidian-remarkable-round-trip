/**
 * Rendering imported annotations into vault markdown (PRD F11; design:
 * docs/ontwerp-inkomende-route.md §4).
 *
 * Everything the plugin generates lives between markers, so a repeated
 * import replaces only its own output and anything you wrote around it
 * survives — the in-file counterpart of N5.
 */

import { Highlight, colorName } from "./highlights";

export const BEGIN_MARKER = "<!-- remarkable-round-trip:begin -->";
export const END_MARKER = "<!-- remarkable-round-trip:end -->";

export interface AnnotationRenderInput {
	/** Vault path of the source note, for the backlink. */
	sourcePath: string;
	/** Basename of the source note, used as link text. */
	sourceName: string;
	highlights: Highlight[];
	/** ISO timestamp of this import. */
	importedAt: string;
}

/** Render the generated block (markers included). */
export function renderAnnotationBlock(input: AnnotationRenderInput): string {
	const lines: string[] = [BEGIN_MARKER, ""];
	lines.push(`Annotations from [[${input.sourceName}]], imported ${input.importedAt}.`);
	lines.push("");

	if (input.highlights.length === 0) {
		lines.push("_No text highlights found in this document._");
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

	// Trailing blank line before the end marker keeps the block readable when
	// a user writes directly underneath it.
	if (lines[lines.length - 1] !== "") lines.push("");
	lines.push(END_MARKER);
	return lines.join("\n");
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
