import { describe, expect, it } from "vitest";
import { dropLeadingTitleHeading, parseBlocks, stripInline } from "../convert/mdblocks";

describe("stripInline", () => {
	it("strips bold, italic, highlight, strike, code and links", () => {
		expect(stripInline("**vet** *schuin* ==merk== ~~weg~~ `code` [tekst](url)")).toBe(
			"vet schuin merk weg code tekst",
		);
	});
});

describe("parseBlocks", () => {
	it("parses headings with level", () => {
		expect(parseBlocks("## Titel")).toEqual([{ type: "heading", level: 2, text: "Titel" }]);
	});

	it("joins consecutive lines into one paragraph", () => {
		const blocks = parseBlocks("regel een\nregel twee\n\nnieuwe alinea");
		expect(blocks).toEqual([
			{ type: "paragraph", text: "regel een regel twee" },
			{ type: "paragraph", text: "nieuwe alinea" },
		]);
	});

	it("parses nested and ordered lists", () => {
		const blocks = parseBlocks("- een\n  - sub\n1. eerste");
		expect(blocks).toHaveLength(1);
		const list = blocks[0];
		if (list.type !== "list") throw new Error("expected list");
		expect(list.items[0]).toMatchObject({ depth: 0, ordered: false, text: "een" });
		expect(list.items[1]).toMatchObject({ depth: 1, text: "sub" });
		expect(list.items[2]).toMatchObject({ ordered: true, text: "eerste" });
	});

	it("parses fenced code without inline stripping", () => {
		const blocks = parseBlocks("```\nconst x = '**niet strippen**';\n```");
		expect(blocks).toEqual([{ type: "code", lines: ["const x = '**niet strippen**';"] }]);
	});

	it("parses quotes and horizontal rules", () => {
		const blocks = parseBlocks("> citaat\n\n---");
		expect(blocks).toEqual([{ type: "quote", lines: ["citaat"] }, { type: "hr" }]);
	});

	it("parses pipe tables into rows", () => {
		const blocks = parseBlocks("| a | b |\n|---|---|\n| 1 | 2 |");
		expect(blocks).toEqual([
			{
				type: "table",
				rows: [
					["a", "b"],
					["1", "2"],
				],
			},
		]);
	});
});

describe("pagebreak marker (GP_E6_S1)", () => {
	it("turns \\pagebreak on its own line into a pagebreak block", () => {
		const blocks = parseBlocks("eerste\n\n\\pagebreak\n\ntweede");
		expect(blocks).toEqual([
			{ type: "paragraph", text: "eerste" },
			{ type: "pagebreak" },
			{ type: "paragraph", text: "tweede" },
		]);
	});

	it("flushes a running paragraph before the break", () => {
		const blocks = parseBlocks("eerste\n\\pagebreak\ntweede");
		expect(blocks.map((b) => b.type)).toEqual(["paragraph", "pagebreak", "paragraph"]);
	});

	it("leaves \\pagebreak inside a sentence alone", () => {
		const blocks = parseBlocks("dit is geen \\pagebreak marker");
		expect(blocks).toEqual([{ type: "paragraph", text: "dit is geen \\pagebreak marker" }]);
	});
});

describe("styled label paragraphs (GP_E6_S7)", () => {
	it("marks a whole-bold paragraph as a bold label", () => {
		expect(parseBlocks("**Doel**")).toEqual([{ type: "paragraph", text: "Doel", style: "bold" }]);
		expect(parseBlocks("__Doel__")).toEqual([{ type: "paragraph", text: "Doel", style: "bold" }]);
	});

	it("marks a whole-italic paragraph as an italic label", () => {
		expect(parseBlocks("*Krachtblok — trekken*")).toEqual([
			{ type: "paragraph", text: "Krachtblok — trekken", style: "italic" },
		]);
		expect(parseBlocks("_cursief_")).toEqual([
			{ type: "paragraph", text: "cursief", style: "italic" },
		]);
	});

	it("keeps mixed or partial styling as a plain paragraph (GP_E6_S8, parked)", () => {
		expect(parseBlocks("**Doel** van vandaag")).toEqual([
			{ type: "paragraph", text: "Doel van vandaag" },
		]);
		expect(parseBlocks("zie **Doel** hier")).toEqual([
			{ type: "paragraph", text: "zie Doel hier" },
		]);
		expect(parseBlocks("**twee** **spans**")).toEqual([
			{ type: "paragraph", text: "twee spans" },
		]);
	});

	it("keeps a multi-line paragraph that starts bold plain", () => {
		expect(parseBlocks("**Doel**\nmet vervolgtekst")).toEqual([
			{ type: "paragraph", text: "Doel met vervolgtekst" },
		]);
	});
});

describe("dropLeadingTitleHeading (GP_E6_S6)", () => {
	it("drops a first H1 that repeats the title, whatever the case or spacing", () => {
		const blocks = parseBlocks("# 90-90 Heuprotatie \n\ntekst");
		expect(dropLeadingTitleHeading(blocks, "90-90 heuprotatie")).toEqual([
			{ type: "paragraph", text: "tekst" },
		]);
	});

	it("keeps a first H1 that says something else", () => {
		const blocks = parseBlocks("# Inleiding\n\ntekst");
		expect(dropLeadingTitleHeading(blocks, "90-90 heuprotatie")).toEqual(blocks);
	});

	it("keeps an H2 and a non-leading H1 alone", () => {
		const sub = parseBlocks("## 90-90 heuprotatie\n\ntekst");
		expect(dropLeadingTitleHeading(sub, "90-90 heuprotatie")).toEqual(sub);
		const later = parseBlocks("tekst\n\n# 90-90 heuprotatie");
		expect(dropLeadingTitleHeading(later, "90-90 heuprotatie")).toEqual(later);
	});
});
