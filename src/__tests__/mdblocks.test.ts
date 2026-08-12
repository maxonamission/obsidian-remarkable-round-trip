import { describe, expect, it } from "vitest";
import { parseBlocks, stripInline } from "../convert/mdblocks";

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
