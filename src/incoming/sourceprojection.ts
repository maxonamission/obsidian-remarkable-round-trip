/**
 * Projecting marks onto the source note (GP_E3_S13).
 *
 * The first annotated copy was *rebuilt* from the layout map, and inherited
 * everything the typesetter had thrown away: bold, italics, links, en dashes,
 * heading levels. Owner comparison 2026-07-27 showed exactly that.
 *
 * So do the opposite. Keep the note as it is and only *insert* markup at the
 * places the pen touched. The layout knows which words were marked and in
 * what order; those same words appear in the same order in the note, just
 * with markdown around them. Aligning the two gives a character range per
 * word — and inserting into the note keeps every last bit of its formatting.
 */

import { PdfLayout, toWinAnsi } from "../convert/pdf";
import { Highlight, colorName, rgbName } from "./highlights";
import { DEFAULT_MARK_STYLES, MarkStyle, MarkStyles } from "./markstyles";
import type { ImportedMark } from "./pull";

/** Markdown punctuation that carries no text and may sit between words. */
const SYNTAX = new Set([
	"*",
	"_",
	"=",
	"~",
	"`",
	"#",
	">",
	"|",
	"[",
	"]",
	"(",
	")",
	"!",
	"\\",
	" ",
	"\t",
	"\n",
	"\r",
]);

/** Highlight colours as inline styling; `==` cannot carry a colour. */
const HIGHLIGHT_CSS: Record<string, string> = {
	yellow: "#ffe066",
	blue: "#a5d8ff",
	pink: "#ffc9de",
	orange: "#ffc078",
	green: "#b2f2bb",
	grey: "#dee2e6",
};

/**
 * The markup for one mark.
 *
 * Markdown by default — the copy should stay readable and editable as
 * markdown. But **markdown inside an inline HTML tag is not parsed**: an
 * underline is `<u>…</u>` because markdown has no underline at all, and a
 * `~~strike~~` within it comes out as literal tildes (beta, 2026-07-28, twice
 * in a row: first blamed on the quotes around the phrase, then measured
 * properly). So a mark that ends up inside an HTML wrapper switches to its
 * own HTML tag, which nests and renders in every Obsidian view.
 */
function wrapperFor(
	kind: string,
	color?: number,
	rgb?: string,
	insideHtml = false,
	styles: MarkStyles = DEFAULT_MARK_STYLES,
): [string, string] {
	// A text highlight is not a shape the user chose, and it carries a colour
	// of its own, so it is the one mark with no style setting.
	if (kind === "highlight") {
		// The device sends its own RGB, so use it verbatim rather than
		// rounding to a palette name (GP_E3_S16).
		const css = rgb ?? HIGHLIGHT_CSS[colorName(color) ?? ""];
		if (css !== undefined) return [`<mark style="background: ${css}">`, "</mark>"];
		return insideHtml ? ["<mark>", "</mark>"] : ["==", "=="];
	}
	const style = styles[kind as keyof MarkStyles];
	return style === undefined ? ["", ""] : wrapperForStyle(style, insideHtml);
}

/** The markup for one style, in markdown or in HTML when it has to nest. */
function wrapperForStyle(style: MarkStyle, insideHtml: boolean): [string, string] {
	switch (style) {
		case "strikethrough":
			return insideHtml ? ["<s>", "</s>"] : ["~~", "~~"];
		case "bold":
			return insideHtml ? ["<strong>", "</strong>"] : ["**", "**"];
		case "italic":
			return insideHtml ? ["<em>", "</em>"] : ["*", "*"];
		case "underline":
			return ["<u>", "</u>"];
		case "highlight":
			return insideHtml ? ["<mark>", "</mark>"] : ["==", "=="];
		default:
			return ["", ""];
	}
}

/** Nesting order, outermost first, so overlapping marks stay well-formed. */
const KIND_ORDER = ["highlight", "circle", "underline", "strikethrough"];

interface Range {
	start: number;
	end: number;
}

/**
 * Match one word against the source from `from`, allowing markdown syntax to
 * sit anywhere inside or before it — `**Grote** financiële` still contains the
 * word "Grote". Returns the end offset, or null when this position is not it.
 */
function matchAt(source: string, from: number, word: string, typo: number): number | null {
	let at = from;
	let taken = 0;
	while (taken < word.length) {
		if (at >= source.length) return null;
		const ch = source[at];
		// Map exactly as the layout was typeset: a legacy layout carries
		// "--" where the source has an em dash (GP_E5_S7).
		const mapped = toWinAnsi(ch, typo);
		if (mapped !== "" && word.startsWith(mapped, taken)) {
			taken += mapped.length;
			at++;
			continue;
		}
		// Syntax may be skipped; anything else means this is a different word.
		if (SYNTAX.has(ch)) {
			at++;
			continue;
		}
		return null;
	}
	return at;
}

/**
 * How far past the cursor a word may be found. Consecutive words sit a few
 * characters apart; the slack is for skipped markup — a link URL, an embed.
 *
 * A *tight* bound is the whole point. Searching the rest of the document
 * (beta, 2026-07-27) let a word that is not in the note at all — the title
 * line the plugin adds — match somewhere far below and drag the cursor with
 * it, after which nothing lined up and the projection gave up entirely.
 */
const WINDOW = 200;

/** Where a word sits in the source, searching forward from `from`. */
function findWord(
	source: string,
	from: number,
	word: string,
	typo: number,
	window = WINDOW,
): Range | null {
	const limit = Math.min(source.length, from + window);
	for (let at = from; at < limit; at++) {
		if (SYNTAX.has(source[at])) continue;
		const end = matchAt(source, at, word, typo);
		if (end !== null) return { start: at, end };
	}
	return null;
}

/**
 * Where the note's own text begins in the layout. The typeset document opens
 * with a title, and optionally with the frontmatter as a title block; neither
 * is part of the note body. Rather than special-casing them, look for the
 * first word that starts a run of three consecutive matches near the top of
 * the note — that is where the two texts genuinely meet.
 */
function syncPoint(source: string, words: { text: string }[], typo: number): number {
	const head = Math.min(words.length, 60);
	for (let index = 0; index < head; index++) {
		let cursor = 0;
		let run = 0;
		for (let step = 0; step < 3 && index + step < words.length; step++) {
			const hit = findWord(source, cursor, words[index + step].text, typo, cursor === 0 ? 400 : 40);
			if (hit === null) break;
			cursor = hit.end;
			run++;
		}
		if (run === 3) return index;
	}
	return 0;
}

export interface ProjectionInput {
	/** The note as it is on disk, frontmatter already removed. */
	source: string;
	layout: PdfLayout;
	highlights: Highlight[];
	marks: ImportedMark[];
	/** How each mark becomes markdown; defaults when not given. */
	styles?: MarkStyles;
}

export interface ProjectionResult {
	markdown: string;
	/** Marks and highlights that found their place in the text. */
	placed: number;
	/** Highlights whose text could not be located. */
	unplaced: Highlight[];
}

/**
 * The note with every mark inserted. Returns null when the text and the
 * layout have nothing in common — then there is nothing to project onto.
 */
export function projectOntoSource(input: ProjectionInput): ProjectionResult | null {
	const words = input.layout.lines.flatMap((line) =>
		line.words.map((word) => ({ ...word, page: line.page, block: line.block })),
	);
	if (words.length === 0 || input.source.trim() === "") return null;

	// Walk both sides forward together. A word that cannot be found (a title
	// the note does not carry, an inlined embed) costs its own mark, and the
	// cursor stays put so the next word can still line up.
	const ranges = new Map<number, Range>();
	// Absent means version 1, the same convention as the mapping entry the
	// layout is rebuilt from (id/mapping.ts) — a legacy layout carries "--"
	// where the source has an em dash, and mapping modern against it fails
	// at the first typographic character.
	const typo = input.layout.typo ?? 1;
	const start = syncPoint(input.source, words, typo);
	let cursor = 0;
	let found = 0;
	for (const word of words.slice(start)) {
		const hit = findWord(input.source, cursor, word.text, typo);
		if (hit === null) continue;
		ranges.set(word.id, hit);
		cursor = hit.end;
		found++;
	}
	if (found < (words.length - start) / 4) return null; // not the same document

	const spans: { kind: string; color?: number; rgb?: string; start: number; end: number }[] =
		[];
	let placed = 0;

	// Task gestures (GP_E5_S12): a tick in a drawn checkbox marks the task
	// line done; a strike-through covering most of a task line cancels it
	// instead of striking its words. Both rewrite the marker, so they leave
	// the span machinery entirely. Strike coverage is aggregated per source
	// line first: a wrapped task is struck in one gesture per visual row,
	// and each gesture alone would stay under any threshold (reviewvondst).
	const lineOf = lineIndexer(input.source);
	const sourceLines = input.source.split("\n");
	const done = new Set<number>();
	const cancelled = new Set<number>();
	const struckPerLine = new Map<number, Set<number>>();

	for (const mark of input.marks) {
		if (mark.kind !== "strikethrough") continue;
		for (const id of mark.words ?? []) {
			const range = ranges.get(id);
			if (range === undefined) continue;
			const line = lineOf(range.start);
			if (!TASK_LINE_RE.test(sourceLines[line])) continue;
			const set = struckPerLine.get(line) ?? new Set<number>();
			set.add(id);
			struckPerLine.set(line, set);
		}
	}
	for (const [line, struck] of struckPerLine) {
		const onLine = words.filter((word) => {
			const range = ranges.get(word.id);
			return range !== undefined && lineOf(range.start) === line;
		}).length;
		// Strictly more than half: striking one word of a two-word task is a
		// word-level strike, not a cancellation.
		if (onLine > 0 && struck.size > onLine / 2) cancelled.add(line);
	}

	for (const mark of input.marks) {
		const covered = (mark.words ?? []).map((id) => ranges.get(id)).filter(isRange);
		if (covered.length === 0) continue;
		const line = lineOf(Math.min(...covered.map((range) => range.start)));
		if (mark.kind === "checkbox" || mark.kind === "checkbox-cancel") {
			if (TASK_LINE_RE.test(sourceLines[line])) {
				(mark.kind === "checkbox" ? done : cancelled).add(line);
				placed++;
			}
			continue;
		}
		if (mark.kind === "strikethrough" && cancelled.has(line)) {
			placed++; // absorbed by the line's cancellation
			continue;
		}
		spans.push({
			kind: mark.kind,
			start: Math.min(...covered.map((range) => range.start)),
			end: Math.max(...covered.map((range) => range.end)),
		});
		placed++;
	}

	const unplaced: Highlight[] = [];
	for (const highlight of input.highlights) {
		const ids = wordIdsOf(words, highlight);
		const covered = ids.map((id) => ranges.get(id)).filter(isRange);
		if (covered.length === 0) {
			unplaced.push(highlight);
			continue;
		}
		spans.push({
			kind: "highlight",
			color: highlight.color,
			rgb: highlight.rgb,
			start: Math.min(...covered.map((range) => range.start)),
			end: Math.max(...covered.map((range) => range.end)),
		});
		placed++;
	}

	let markdown = applySpans(input.source, spans, input.styles);
	// Before applyBlockMarks: that step inserts lines, and the task-state
	// rewrite addresses lines by their untouched-source index (applySpans
	// only inserts inline, so those indices still hold here).
	markdown = applyTaskStates(markdown, done, cancelled);
	markdown = applyBlockMarks(markdown, input, words, ranges);

	if (unplaced.length > 0) {
		markdown += "\n\n**Highlights that could not be placed in the text**\n\n";
		for (const highlight of unplaced) {
			const color = rgbName(highlight.rgb) ?? colorName(highlight.color);
			markdown += `- ==${highlight.text}==${color === undefined ? "" : ` ^[${color}]`}\n`;
		}
	}
	return { markdown: markdown.trimEnd(), placed, unplaced };
}

/** A markdown task line: bullet, then a checkbox marker. */
const TASK_LINE_RE = /^\s*[-*+]\s+\[( |x|X)\]/;

/**
 * Rewrite task markers in the annotated copy (GP_E5_S12): `[ ]` becomes
 * `[x]` for a ticked box, `[-]` for a struck (cancelled) task — cancelled
 * wins when one line somehow carries both. Same-length replacements, so no
 * offset in the document shifts.
 */
function applyTaskStates(markdown: string, done: Set<number>, cancelled: Set<number>): string {
	if (done.size === 0 && cancelled.size === 0) return markdown;
	const lines = markdown.split("\n");
	const apply = (index: number, state: string) => {
		if (index >= lines.length) return;
		lines[index] = lines[index].replace(/^(\s*[-*+]\s+)\[( |x|X)\]/, `$1[${state}]`);
	};
	for (const index of done) if (!cancelled.has(index)) apply(index, "x");
	for (const index of cancelled) apply(index, "-");
	return lines.join("\n");
}

function isRange(range: Range | undefined): range is Range {
	return range !== undefined;
}

/** The layout words a highlight's text covers, on its own page. */
function wordIdsOf(
	words: { id: number; text: string; page: number }[],
	highlight: Highlight,
): number[] {
	const wanted = highlight.text.trim().split(/\s+/);
	if (wanted.length === 0) return [];
	for (let at = 0; at + wanted.length <= words.length; at++) {
		if (highlight.page !== undefined && words[at].page !== highlight.page) continue;
		const run = words.slice(at, at + wanted.length);
		if (run.every((word, index) => word.text === wanted[index])) return run.map((w) => w.id);
	}
	return [];
}

/**
 * Insert the markup. Ranges of one kind that overlap or touch are merged
 * first: two strike-throughs over the same phrase must not produce `~~~~`,
 * which markdown reads as nothing at all (beta, 2026-07-27).
 */
function applySpans(
	source: string,
	spans: { kind: string; color?: number; rgb?: string; start: number; end: number }[],
	styles: MarkStyles = DEFAULT_MARK_STYLES,
): string {
	const merged: typeof spans = [];
	for (const kind of KIND_ORDER) {
		const ofKind = spans.filter((span) => span.kind === kind).sort((a, b) => a.start - b.start);
		for (const span of ofKind) {
			const last = merged[merged.length - 1];
			if (last !== undefined && last.kind === kind && span.start <= last.end) {
				last.end = Math.max(last.end, span.end);
				continue;
			}
			merged.push({ ...span });
		}
	}

	const edits: { at: number; text: string; rank: number }[] = [];
	// Spans arrive outermost-kind first, so a wrapper's own choice is settled
	// before the marks nested inside it have to make theirs.
	const html: Range[] = [];
	for (const span of splitAtOuterEdges(merged)) {
		const insideHtml = html.some((outer) => outer.start <= span.start && span.end <= outer.end);
		const [open, close] = wrapperFor(span.kind, span.color, span.rgb, insideHtml, styles);
		if (open === "") continue;
		// A markdown delimiter has to touch the text it marks; an HTML tag can
		// sit anywhere. Only the former needs the punctuation moved out.
		const range = open.startsWith("<") ? span : tightenToWord(source, span);
		if (range === null) continue;
		if (open.startsWith("<")) html.push(range);
		const depth = KIND_ORDER.indexOf(span.kind);
		edits.push({ at: range.start, text: open, rank: depth });
		edits.push({ at: range.end, text: close, rank: -depth });
	}
	// Apply back to front so earlier offsets stay valid; at one position the
	// outer wrapper opens first and closes last.
	edits.sort((a, b) => b.at - a.at || b.rank - a.rank);
	let out = source;
	for (const edit of edits) {
		out = out.slice(0, edit.at) + edit.text + out.slice(edit.at);
	}
	return out;
}

/**
 * Pull a range in until it starts and ends on a letter or digit.
 *
 * Markdown delimiters are flanking-sensitive: `~~"Laten we …"~~` leaves the
 * tildes in the text as literal characters, because the delimiter opens
 * against a quote rather than a word (beta, 2026-07-28). Marking the phrase
 * *inside* its quotes — `"~~Laten we …~~"` — says the same thing and renders.
 *
 * Returns null when nothing but punctuation was covered; there is no sensible
 * markdown for striking a lone quote mark.
 */
function tightenToWord(source: string, span: Range): Range | null {
	const wordish = /[\p{L}\p{N}]/u;
	let { start, end } = span;
	while (start < end && !wordish.test(source[start])) start++;
	while (end > start && !wordish.test(source[end - 1])) end--;
	return end > start ? { start, end } : null;
}

/**
 * Cut every span at the edges of the kinds that nest outside it.
 *
 * A strike-through that starts before a highlight and ends inside it would
 * otherwise produce `~~plannen <mark>maken en~~ investeren…</mark>` —
 * crossing tags, which markdown renders by leaving a stray `~~` in the text
 * (beta, 2026-07-28). Splitting the inner mark at the boundary gives
 * `~~plannen ~~<mark>~~maken en~~ investeren…</mark>`: same meaning, properly
 * nested.
 */
function splitAtOuterEdges<T extends { kind: string; start: number; end: number }>(
	spans: T[],
): T[] {
	const out: T[] = [];
	for (const span of spans) {
		const depth = KIND_ORDER.indexOf(span.kind);
		// Only spans that wrap *outside* this one can break its nesting.
		const cuts = spans
			.filter((other) => KIND_ORDER.indexOf(other.kind) < depth)
			.flatMap((other) => [other.start, other.end])
			.filter((at) => at > span.start && at < span.end)
			.sort((a, b) => a - b);
		let from = span.start;
		for (const at of [...new Set(cuts), span.end]) {
			out.push({ ...span, start: from, end: at });
			from = at;
		}
	}
	return out;
}

/**
 * Marks that act on whole lines: a bar in the margin quotes them, a remark
 * is appended below them. Line numbers come from the untouched source, and
 * inline insertions add no newlines, so they still hold.
 */
function applyBlockMarks(
	markdown: string,
	input: ProjectionInput,
	words: { id: number; text: string; block: number }[],
	ranges: Map<number, Range>,
): string {
	const lineOf = lineIndexer(input.source);
	const lines = markdown.split("\n");
	const quoted = new Set<number>();
	const remarks = new Map<number, string[]>();

	for (const mark of input.marks) {
		const blocks = new Set(mark.blocks ?? []);
		const own = words.filter((word) => blocks.has(word.block) && ranges.has(word.id));
		const touched = own.map((word) => lineOf(ranges.get(word.id)!.start));

		if (mark.kind === "margin" && touched.length > 0) {
			for (let line = Math.min(...touched); line <= Math.max(...touched); line++) {
				quoted.add(line);
			}
			continue;
		}
		if (mark.kind === "note") {
			const anchor = anchorLine(mark, words, ranges, lineOf, lines.length - 1);
			// A whole page added on the device is not a remark in the margin;
			// say what it is, so a page of thinking is not mistaken for a
			// scribble (GP_E3_S20).
			const title =
				mark.addedPage === undefined
					? "> [!note] Remark"
					: `> [!note] Page added on the reMarkable (page ${mark.addedPage})`;
			remarks.set(anchor, [
				...(remarks.get(anchor) ?? []),
				title,
				...(mark.path === undefined ? [] : [`> ![[${mark.path}]]`]),
			]);
		}
	}

	const out: string[] = [];
	lines.forEach((line, index) => {
		out.push(quoted.has(index) && !line.startsWith(">") ? `> ${line}` : line);
		const remark = remarks.get(index);
		if (remark !== undefined) out.push("", ...remark);
	});
	return out.join("\n");
}

/** Offset → line index, via the line starts of the untouched source. */
function lineIndexer(source: string): (offset: number) => number {
	const starts = [0];
	for (let at = 0; at < source.length; at++) {
		if (source[at] === "\n") starts.push(at + 1);
	}
	return (offset: number) => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (starts[mid] <= offset) low = mid;
			else high = mid - 1;
		}
		return low;
	};
}

/** The line a free remark belongs under: the last line of its quoted text. */
function anchorLine(
	mark: ImportedMark,
	words: { id: number; text: string }[],
	ranges: Map<number, Range>,
	lineOf: (offset: number) => number,
	fallback: number,
): number {
	const quote = mark.quote?.trim();
	if (quote === undefined || quote === "") return fallback;
	const wanted = quote.split(/\s+/).slice(0, 4);
	for (let at = 0; at + wanted.length <= words.length; at++) {
		const run = words.slice(at, at + wanted.length);
		if (!run.every((word, index) => word.text === wanted[index])) continue;
		const range = ranges.get(run[run.length - 1].id);
		if (range !== undefined) return lineOf(range.start);
	}
	return fallback;
}
