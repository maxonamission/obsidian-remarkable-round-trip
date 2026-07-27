import { beforeAll, describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { PdfLayout, renderPdf } from "../convert/pdf";
import { renderAnnotatedCopy } from "../incoming/annotatedcopy";
import type { ImportedMark } from "../incoming/pull";

const MARKDOWN = [
	"## De beperkte blik",
	"",
	"Neem die groeiende ledencijfers. Ze vertellen niet waarom mensen lid worden.",
	"",
	"- eerste punt",
	"- tweede punt",
	"",
	"> een citaat uit de bron",
].join("\n");

let layout: PdfLayout;

beforeAll(async () => {
	const rendered = await renderPdf(parseBlocks(MARKDOWN), {
		title: "Artikel datagedreven organiseren",
		docId: "d",
	});
	layout = rendered.layout;
});

/** Ids of the words making up a phrase, as the typesetter placed them. */
function idsOf(phrase: string): number[] {
	const wanted = phrase.split(" ");
	const words = layout.lines.flatMap((line) => line.words);
	for (let at = 0; at + wanted.length <= words.length; at++) {
		const run = words.slice(at, at + wanted.length);
		if (run.every((word, i) => word.text === wanted[i])) return run.map((word) => word.id);
	}
	throw new Error(`phrase not laid out: ${phrase}`);
}

/** The block number a phrase belongs to. */
function blockOf(phrase: string): number {
	const line = layout.lines.find((candidate) => candidate.text.includes(phrase));
	if (line === undefined) throw new Error(`phrase not laid out: ${phrase}`);
	return line.block;
}

const copy = (marks: ImportedMark[], highlights: Parameters<typeof renderAnnotatedCopy>[0]["highlights"] = []) =>
	renderAnnotatedCopy({ layout, marks, highlights }) ?? "";

describe("renderAnnotatedCopy", () => {
	it("reproduces the document, headings and lists included", () => {
		const out = copy([]);
		expect(out).toContain("# Artikel datagedreven organiseren");
		expect(out).toContain("### De beperkte blik");
		expect(out).toContain("Neem die groeiende ledencijfers.");
		expect(out).toContain("- eerste punt");
		expect(out).toContain("- tweede punt");
		expect(out).toContain("> een citaat uit de bron");
	});

	it("strikes through exactly the words the pen crossed", () => {
		const out = copy([
			{ kind: "strikethrough", page: 1, words: idsOf("groeiende ledencijfers.") },
		]);
		expect(out).toContain("Neem die ~~groeiende ledencijfers.~~ Ze vertellen");
	});

	it("underlines and bolds the other two shapes", () => {
		const out = copy([
			{ kind: "underline", page: 1, words: idsOf("Ze vertellen niet") },
			{ kind: "circle", page: 1, words: idsOf("eerste punt") },
		]);
		expect(out).toContain("<u>Ze vertellen niet</u>");
		expect(out).toContain("- **eerste punt**");
	});

	it("turns a block marked in the margin into a quote", () => {
		const out = copy([{ kind: "margin", page: 1, blocks: [blockOf("Neem die groeiende")] }]);
		expect(out).toContain("> Neem die groeiende ledencijfers.");
	});

	it("highlights carry their colour, so the reading survives the trip", () => {
		const out = copy([], [{ text: "Ze vertellen niet waarom mensen", color: 1, page: 1 }]);
		expect(out).toContain('<mark style="background: #a5d8ff">Ze vertellen niet waarom mensen</mark>');
	});

	it("falls back to plain highlight syntax when the colour is unknown", () => {
		const out = copy([], [{ text: "eerste punt", page: 1 }]);
		expect(out).toContain("- ==eerste punt==");
	});

	it("keeps a highlight it cannot place, rather than dropping it", () => {
		const out = copy([], [{ text: "staat niet in dit document", page: 1 }]);
		expect(out).toContain("could not be placed");
		expect(out).toContain("==staat niet in dit document==");
	});

	it("puts unrecognised ink as a remark after the block it sits against", () => {
		const out = copy([
			{
				kind: "note",
				page: 1,
				quote: "Neem die groeiende ledencijfers. Ze vertellen niet waarom mensen lid",
				path: "img/dev-p01-1.png",
			},
		]);
		const lines = out.split("\n");
		const paragraph = lines.findIndex((line) => line.includes("Neem die groeiende"));
		const remark = lines.findIndex((line) => line.includes("[!note] Remark"));
		expect(remark).toBeGreaterThan(paragraph);
		expect(out).toContain("![[img/dev-p01-1.png]]");
	});

	it("nests two marks on the same words without garbling them", () => {
		const ids = idsOf("eerste punt");
		const out = copy([{ kind: "circle", page: 1, words: ids }], [
			{ text: "eerste punt", color: 3, page: 1 },
		]);
		expect(out).toContain('<mark style="background: #ffe066">**eerste punt**</mark>');
	});

	it("returns null when there is no layout to rebuild from", () => {
		const empty: PdfLayout = { pageWidth: 447, pageHeight: 596, pageCount: 0, lines: [] };
		expect(renderAnnotatedCopy({ layout: empty, marks: [], highlights: [] })).toBeNull();
	});
});
