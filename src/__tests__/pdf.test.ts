import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { parseBlocks } from "../convert/mdblocks";
import { renderPdf, toWinAnsi, DOCID_SUBJECT_PREFIX, PAGE_WIDTH, PAGE_HEIGHT } from "../convert/pdf";

const META = { title: "Testnotitie", docId: "0f8fad5b-d9cb-469f-a165-70867728950e" };

describe("toWinAnsi", () => {
	it("maps common typographic characters to ASCII fallbacks", () => {
		expect(toWinAnsi("a → b — 'x' … ≤5")).toBe("a -> b -- 'x' ... <=5");
	});

	it("keeps Latin-1 diacritics intact", () => {
		expect(toWinAnsi("café über señor")).toBe("café über señor");
	});

	it("replaces unencodable characters", () => {
		expect(toWinAnsi("日本")).toBe("??");
	});
});

describe("renderPdf", () => {
	it("produces a valid PDF with reMarkable page size and docId metadata", async () => {
		const bytes = await renderPdf(parseBlocks("Eén alinea."), META);
		expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");

		const doc = await PDFDocument.load(bytes);
		expect(doc.getTitle()).toBe("Testnotitie");
		expect(doc.getSubject()).toBe(`${DOCID_SUBJECT_PREFIX}${META.docId}`);
		const page = doc.getPage(0);
		expect(Math.round(page.getWidth())).toBe(PAGE_WIDTH);
		expect(Math.round(page.getHeight())).toBe(PAGE_HEIGHT);
	});

	it("breaks long content across multiple pages", async () => {
		const longText = Array.from({ length: 120 }, (_, i) => `Alinea ${i} met wat tekst erbij.`).join("\n\n");
		const bytes = await renderPdf(parseBlocks(longText), META);
		const doc = await PDFDocument.load(bytes);
		expect(doc.getPageCount()).toBeGreaterThan(1);
	});

	it("renders all block types without throwing", async () => {
		const md = [
			"# Kop",
			"Alinea met **vet**.",
			"- item een\n- item twee",
			"> citaat",
			"```\ncode regel\n```",
			"| a | b |\n|---|---|\n| 1 | 2 |",
			"---",
		].join("\n\n");
		const bytes = await renderPdf(parseBlocks(md), META);
		expect(bytes.length).toBeGreaterThan(500);
	});
});
