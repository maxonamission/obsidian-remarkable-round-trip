import { describe, expect, it } from "vitest";
import {
	BEGIN_MARKER,
	END_MARKER,
	companionPath,
	renderAnnotationBlock,
	upsertAnnotationBlock,
} from "../incoming/annotationnote";

const INPUT = {
	sourcePath: "map/Nota.md",
	sourceName: "Nota",
	importedAt: "2026-07-25T12:00:00Z",
	highlights: [
		{ text: "eerste inzicht", color: 3, page: 1 },
		{ text: "tweede inzicht", color: 4, page: 1 },
		{ text: "op pagina twee", page: 2 },
	],
};

describe("renderAnnotationBlock", () => {
	it("renders highlights as quotes grouped per page, with a backlink", () => {
		const block = renderAnnotationBlock(INPUT);
		expect(block.startsWith(BEGIN_MARKER)).toBe(true);
		expect(block.trimEnd().endsWith(END_MARKER)).toBe(true);
		expect(block).toContain("[[Nota]]");
		expect(block).toContain("### Page 1");
		expect(block).toContain("### Page 2");
		expect(block).toContain("> eerste inzicht ^[yellow]");
		expect(block).toContain("> op pagina twee");
	});

	it("says so plainly when a document holds neither highlights nor handwriting", () => {
		const block = renderAnnotationBlock({ ...INPUT, highlights: [] });
		expect(block).toContain("_No text highlights or handwriting found");
	});

	it("embeds handwriting images per page", () => {
		const block = renderAnnotationBlock({
			...INPUT,
			images: [
				{ path: "reMarkable-in/handwriting/dev-p01.png", page: 1, quote: "de zin ernaast" },
				{ path: "reMarkable-in/handwriting/dev-p02.png", page: 2 },
			],
		});
		expect(block).toContain("### Handwriting");
		expect(block).toContain("**Page 1**");
		expect(block).toContain("> de zin ernaast");
		expect(block).toContain("![[reMarkable-in/handwriting/dev-p01.png]]");
		expect(block).toContain("![[reMarkable-in/handwriting/dev-p02.png]]");
	});

	it("mentions handwriting when there are images but no highlights", () => {
		const block = renderAnnotationBlock({
			...INPUT,
			highlights: [],
			images: [{ path: "a.png" }],
		});
		expect(block).toContain("_No text highlights; handwriting is shown below._");
		expect(block).toContain("![[a.png]]");
	});
});

describe("upsertAnnotationBlock", () => {
	const block = renderAnnotationBlock(INPUT);

	it("appends the block to a note that has none yet", () => {
		const result = upsertAnnotationBlock("Mijn eigen aantekening.\n", block);
		expect(result).toContain("Mijn eigen aantekening.");
		expect(result).toContain(BEGIN_MARKER);
	});

	it("replaces only the generated block, keeping surrounding text intact", () => {
		const existing = `Boven.\n\n${BEGIN_MARKER}\noud\n${END_MARKER}\n\nOnder.\n`;
		const result = upsertAnnotationBlock(existing, block);
		expect(result).toContain("Boven.");
		expect(result).toContain("Onder.");
		expect(result).not.toContain("oud");
		expect(result.match(new RegExp(BEGIN_MARKER, "g"))).toHaveLength(1);
	});

	it("is idempotent: importing twice yields the same file", () => {
		const once = upsertAnnotationBlock("", block);
		expect(upsertAnnotationBlock(once, block)).toBe(once);
	});

	it("appends when the markers are damaged rather than corrupting the note", () => {
		const broken = `tekst\n${END_MARKER}\n${BEGIN_MARKER}\n`;
		const result = upsertAnnotationBlock(broken, block);
		expect(result).toContain("tekst");
		expect(result).toContain(block);
	});
});

describe("companionPath", () => {
	it("puts the companion note in the configured folder", () => {
		expect(companionPath("map/Nota.md", "reMarkable-in")).toBe(
			"reMarkable-in/Nota — annotations.md",
		);
	});

	it("falls back to the vault root when no folder is set", () => {
		expect(companionPath("map/Nota.md", "")).toBe("Nota — annotations.md");
	});
});
