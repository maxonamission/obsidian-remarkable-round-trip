/**
 * The annotated copy: the document as it went out, with every mark woven in
 * (GP_E3_S12).
 *
 * Owner steer 2026-07-26: "ik zou liever een integrale kopie zien van het
 * origineel met de markeringen daarin verwerkt als markdown". A list of
 * annotations forces you to reconstruct the argument from fragments; the
 * whole text with the marks in place *is* the reading, and it is what you can
 * search, link and quote from later.
 *
 * The copy is rebuilt from the layout map, which knows what each line was —
 * heading, paragraph, list item, quote, code, table row — and which words sat
 * where. So the marks land on exactly the words they covered.
 *
 * Conventions (owner, same steer):
 * | mark | markdown |
 * |---|---|
 * | strike-through | `~~text~~` |
 * | underline | `<u>text</u>` |
 * | circle | `**text**` |
 * | highlight | `==text==`, colour noted when it is not the default |
 * | bar in the margin | that block becomes a `>` quote |
 * | anything else | a callout at that spot, with the ink |
 */

import { LaidOutLine, PdfLayout } from "../convert/pdf";
import { Highlight, colorName } from "./highlights";
import type { ImportedMark } from "./pull";

/**
 * Highlight colours as the reader saw them. Obsidian's `==` syntax carries no
 * colour, so a known colour becomes an inline `<mark>` — the owner asked for
 * the colours to come over correctly, and this is the only form that does it.
 */
const HIGHLIGHT_CSS: Record<string, string> = {
	yellow: "#ffe066",
	blue: "#a5d8ff",
	pink: "#ffc9de",
	orange: "#ffc078",
	green: "#b2f2bb",
	grey: "#dee2e6",
};

/** Opening and closing markup for one span. */
function wrapperFor(span: Span): [string, string] {
	switch (span.kind) {
		case "strikethrough":
			return ["~~", "~~"];
		case "underline":
			return ["<u>", "</u>"];
		case "circle":
			return ["**", "**"];
		case "highlight": {
			const css = HIGHLIGHT_CSS[colorName(span.color) ?? ""];
			return css === undefined ? ["==", "=="] : [`<mark style="background: ${css}">`, "</mark>"];
		}
		default:
			return ["", ""];
	}
}

/** Spans that produce markup, in a fixed nesting order. */
const WRAPPED_KINDS = ["highlight", "circle", "underline", "strikethrough"];

function markupSpans(spans: Span[]): Span[] {
	return WRAPPED_KINDS.flatMap((kind) => spans.filter((span) => span.kind === kind));
}

function spanKey(spans: Span[]): string {
	return spans.map((span) => `${span.kind}:${span.color ?? ""}`).join("|");
}

interface Block {
	number: number;
	page: number;
	role: LaidOutLine["role"];
	level?: number;
	ordered?: number;
	lines: LaidOutLine[];
}

/** Group the layout back into the source blocks it was typeset from. */
function blocksOf(layout: PdfLayout): Block[] {
	const byNumber = new Map<number, Block>();
	for (const line of layout.lines) {
		const existing = byNumber.get(line.block);
		if (existing === undefined) {
			byNumber.set(line.block, {
				number: line.block,
				page: line.page,
				role: line.role,
				level: line.level,
				ordered: line.ordered,
				lines: [line],
			});
		} else {
			existing.lines.push(line);
		}
	}
	return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** Rows within a block, top to bottom, each joined left to right. */
function rowsOfBlock(block: Block): LaidOutLine[][] {
	const byBaseline = new Map<string, LaidOutLine[]>();
	for (const line of block.lines) {
		const key = `${line.page}:${Math.round(line.y * 2) / 2}`;
		const existing = byBaseline.get(key);
		if (existing === undefined) byBaseline.set(key, [line]);
		else existing.push(line);
	}
	return [...byBaseline.values()]
		.map((lines) => [...lines].sort((a, b) => a.x - b.x))
		.sort((a, b) => a[0].page - b[0].page || b[0].y - a[0].y);
}

interface Span {
	kind: string;
	color?: number;
}

/**
 * Render a block's words, wrapping each run of consecutively marked words in
 * its markdown. A word can carry more than one mark — circled *and*
 * highlighted — so the wrappers nest in a fixed order.
 */
function renderWords(rows: LaidOutLine[][], spans: Map<number, Span[]>, joiner: string): string {
	return rows
		.map((row) => {
			// Consecutive words carrying the same marks form one segment; the
			// markup then wraps the phrase rather than every single word.
			const segments: { spans: Span[]; words: string[] }[] = [];
			for (const word of row.flatMap((line) => line.words)) {
				const wanted = markupSpans(spans.get(word.id) ?? []);
				const last = segments[segments.length - 1];
				if (last !== undefined && spanKey(last.spans) === spanKey(wanted)) {
					last.words.push(word.text);
				} else {
					segments.push({ spans: wanted, words: [word.text] });
				}
			}
			return segments
				.map((segment) => {
					const text = segment.words.join(" ");
					return segment.spans.reduceRight((inner, span) => {
						const [open, close] = wrapperFor(span);
						return `${open}${inner}${close}`;
					}, text);
				})
				.join(" ");
		})
		.join(joiner);
}

/** Prefix for a block, given its role. */
function prefixOf(block: Block): string {
	switch (block.role) {
		case "title":
			return "# ";
		case "heading":
			return `${"#".repeat(Math.min((block.level ?? 1) + 1, 6))} `;
		case "list":
			return `${"  ".repeat(block.level ?? 0)}${block.ordered === undefined ? "- " : `${block.ordered}. `}`;
		case "quote":
			return "> ";
		default:
			return "";
	}
}

export interface AnnotatedCopyInput {
	layout: PdfLayout;
	highlights: Highlight[];
	marks: ImportedMark[];
}

/**
 * The document with its annotations in place. Returns null when there is no
 * layout to rebuild from — the caller then falls back to the annotation list.
 */
export function renderAnnotatedCopy(input: AnnotatedCopyInput): string | null {
	const blocks = blocksOf(input.layout);
	if (blocks.length === 0) return null;

	// Word-level marks first: which words carry which wrapper.
	const spans = new Map<number, Span[]>();
	for (const mark of input.marks) {
		if (mark.words === undefined) continue;
		for (const id of mark.words) {
			spans.set(id, [...(spans.get(id) ?? []), { kind: mark.kind }]);
		}
	}
	const matched = placeHighlights(blocks, input.highlights, spans);

	// Block-level marks: a bar in the margin turns its blocks into a quote.
	const quoted = new Set<number>();
	for (const mark of input.marks) {
		if (mark.kind === "margin") for (const block of mark.blocks ?? []) quoted.add(block);
	}

	// Remarks that stay ink, keyed by the block they sit against.
	const notes = new Map<number, ImportedMark[]>();
	for (const mark of input.marks) {
		if (mark.kind !== "note") continue;
		const block = blockNear(blocks, mark);
		notes.set(block, [...(notes.get(block) ?? []), mark]);
	}

	const out: string[] = [];
	for (const block of blocks) {
		const rows = rowsOfBlock(block);
		// Code keeps its line breaks; everything else was wrapped by us and
		// reads as one paragraph again.
		const joiner = block.role === "code" ? "\n" : " ";
		const body = renderWords(rows, spans, joiner);
		if (body.trim() !== "") {
			const prefix = prefixOf(block);
			const quotePrefix = quoted.has(block.number) && block.role !== "quote" ? "> " : "";
			if (block.role === "code") {
				out.push("```", body, "```", "");
			} else {
				out.push(
					body
						.split("\n")
						.map((line) => `${quotePrefix}${prefix}${line}`)
						.join("\n"),
					"",
				);
			}
		}
		for (const note of notes.get(block.number) ?? []) {
			out.push("> [!note] Remark", ...(note.path ? [`> ![[${note.path}]]`] : []), "");
		}
	}

	const unplaced = input.highlights.filter((_, index) => !matched.has(index));
	if (unplaced.length > 0) {
		out.push("", "**Highlights that could not be placed in the text**", "");
		for (const highlight of unplaced) {
			const color = colorName(highlight.color);
			out.push(`- ==${highlight.text}==${color === undefined ? "" : ` ^[${color}]`}`);
		}
		out.push("");
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Find each highlight's words in the copy. The highlighted text comes from
 * the PDF *we* generated, so it matches word for word — but only on its own
 * page, which keeps a repeated phrase from being marked in the wrong place.
 */
function placeHighlights(
	blocks: Block[],
	highlights: Highlight[],
	spans: Map<number, Span[]>,
): Set<number> {
	const matched = new Set<number>();
	const words = blocks
		.flatMap((block) => block.lines)
		.flatMap((line) => line.words.map((word) => ({ ...word, page: line.page })));

	highlights.forEach((highlight, index) => {
		const wanted = highlight.text.trim().split(/\s+/);
		if (wanted.length === 0) return;
		for (let at = 0; at + wanted.length <= words.length; at++) {
			if (highlight.page !== undefined && words[at].page !== highlight.page) continue;
			const run = words.slice(at, at + wanted.length);
			if (!run.every((word, i) => word.text === wanted[i])) continue;
			for (const word of run) {
				spans.set(word.id, [
					...(spans.get(word.id) ?? []),
					{ kind: "highlight", color: highlight.color },
				]);
			}
			matched.add(index);
			return;
		}
	});
	return matched;
}

/** The block a free remark sits against, by page and vertical position. */
function blockNear(blocks: Block[], mark: ImportedMark): number {
	if (mark.quote === undefined) return blocks[blocks.length - 1].number;
	const hit = blocks.find((block) =>
		rowsOfBlock(block).some((row) =>
			row
				.map((line) => line.text.trim())
				.join(" ")
				.includes(mark.quote?.slice(0, 40) ?? ""),
		),
	);
	return hit?.number ?? blocks[blocks.length - 1].number;
}
