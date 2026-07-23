/**
 * Minimal markdown block parser for the PDF typesetter (PRD F3, K1).
 *
 * Consumes preprocessed markdown (see preprocess.ts) and produces a flat list
 * of typed blocks. Inline markers (bold/italic/highlight/strike/inline code)
 * are stripped to plain text: the e-ink layout deliberately favors clean,
 * predictable typography over rich inline styling in this MVP.
 */

export type Block =
	| { type: "heading"; level: number; text: string }
	| { type: "paragraph"; text: string }
	| { type: "list"; items: ListItem[] }
	| { type: "quote"; lines: string[] }
	| { type: "code"; lines: string[] }
	| { type: "table"; rows: string[][] }
	| { type: "hr" };

export interface ListItem {
	depth: number;
	ordered: boolean;
	marker: string;
	text: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE_RE = /^(?:```|~~~)/;
const TABLE_DIVIDER_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/** Strip inline markdown markers, keeping the readable text. */
export function stripInline(text: string): string {
	return text
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "$1")
		.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "$1")
		.replace(/==([^=]+)==/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

function parseTableRow(line: string): string[] {
	return line
		.replace(/^\s*\|/, "")
		.replace(/\|\s*$/, "")
		.split("|")
		.map((cell) => stripInline(cell.trim()));
}

export function parseBlocks(markdown: string): Block[] {
	const lines = markdown.split("\n");
	const blocks: Block[] = [];
	let paragraph: string[] = [];
	let list: ListItem[] = [];
	let quote: string[] = [];

	const flushParagraph = () => {
		if (paragraph.length > 0) {
			blocks.push({ type: "paragraph", text: stripInline(paragraph.join(" ").trim()) });
			paragraph = [];
		}
	};
	const flushList = () => {
		if (list.length > 0) {
			blocks.push({ type: "list", items: list });
			list = [];
		}
	};
	const flushQuote = () => {
		if (quote.length > 0) {
			blocks.push({ type: "quote", lines: quote });
			quote = [];
		}
	};
	const flushAll = () => {
		flushParagraph();
		flushList();
		flushQuote();
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (FENCE_RE.test(line.trim())) {
			flushAll();
			const code: string[] = [];
			i++;
			while (i < lines.length && !FENCE_RE.test(lines[i].trim())) {
				code.push(lines[i]);
				i++;
			}
			blocks.push({ type: "code", lines: code });
			continue;
		}

		if (line.trim() === "") {
			flushAll();
			continue;
		}

		const heading = line.match(HEADING_RE);
		if (heading) {
			flushAll();
			blocks.push({
				type: "heading",
				level: heading[1].length,
				text: stripInline(heading[2].trim()),
			});
			continue;
		}

		if (HR_RE.test(line.trim()) && paragraph.length === 0) {
			flushAll();
			blocks.push({ type: "hr" });
			continue;
		}

		if (line.trimStart().startsWith(">")) {
			flushParagraph();
			flushList();
			quote.push(stripInline(line.replace(/^\s*>\s?/, "")));
			continue;
		}
		flushQuote();

		// Table: a header row directly followed by a divider row.
		if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER_RE.test(lines[i + 1])) {
			flushAll();
			const rows: string[][] = [parseTableRow(line)];
			i += 2;
			while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
				rows.push(parseTableRow(lines[i]));
				i++;
			}
			i--;
			blocks.push({ type: "table", rows });
			continue;
		}

		const item = line.match(LIST_RE);
		if (item) {
			flushParagraph();
			const indent = item[1].replace(/\t/g, "  ").length;
			const marker = item[2];
			list.push({
				depth: Math.floor(indent / 2),
				ordered: /\d/.test(marker),
				marker: marker,
				text: stripInline(item[3].trim()),
			});
			continue;
		}

		if (list.length > 0) {
			// Continuation line of the previous list item.
			list[list.length - 1].text += ` ${stripInline(line.trim())}`;
			continue;
		}

		paragraph.push(line.trim());
	}

	flushAll();
	return blocks;
}
