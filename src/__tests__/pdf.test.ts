import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { parseBlocks } from "../convert/mdblocks";
import {
	computeColumnWidths,
	renderPdf,
	toWinAnsi,
	DOCID_SUBJECT_PREFIX,
	PAGE_WIDTH,
	PAGE_HEIGHT,
} from "../convert/pdf";

const META = { title: "Testnotitie", docId: "0f8fad5b-d9cb-469f-a165-70867728950e" };

/** Inflate every Flate stream in the PDF and return the readable contents. */
function inflateContentStreams(bytes: Uint8Array): string {
	const buffer = Buffer.from(bytes);
	const pieces: string[] = [];
	let offset = 0;
	for (;;) {
		const start = buffer.indexOf("stream", offset);
		if (start === -1) break;
		const dataStart = buffer.indexOf("\n", start) + 1;
		const end = buffer.indexOf("endstream", dataStart);
		if (dataStart === 0 || end === -1) break;
		try {
			pieces.push(zlib.inflateSync(buffer.subarray(dataStart, end)).toString("latin1"));
		} catch {
			// Not a Flate stream (e.g. font data) — skip.
		}
		offset = end + 1;
	}
	// pdf-lib writes drawn text as hex strings (<53747...> Tj) — decode them.
	return pieces
		.join("\n")
		.replace(/<([0-9A-Fa-f\s]+)>/g, (_all, hex: string) =>
			Buffer.from(hex.replace(/\s/g, ""), "hex").toString("latin1"),
		);
}

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

describe("computeColumnWidths", () => {
	it("keeps natural widths when everything fits", () => {
		expect(computeColumnWidths([100, 50, 80], 400)).toEqual([100, 50, 80]);
	});

	it("shrinks wide columns proportionally but keeps narrow ones readable", () => {
		const widths = computeColumnWidths([300, 60, 300], 400);
		expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(400, 5);
		// Narrow column keeps at least the minimum width.
		expect(widths[1]).toBeGreaterThanOrEqual(56);
		// Equal wide columns stay equal.
		expect(widths[0]).toBeCloseTo(widths[2], 5);
	});

	it("falls back to an equal split in degenerate cases", () => {
		const widths = computeColumnWidths([500, 500], 100);
		expect(widths).toEqual([50, 50]);
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

	it("renders a wide table without dropping cell content (wraps instead)", async () => {
		const md = [
			"| Doelgroep | Algemene leerdoelen | Kennis | Vaardigheden | Bewustzijn |",
			"|---|---|---|---|---|",
			"| Leidinggevenden | Strategisch sturen op datakwaliteit | Begrijpen van definities | Kunnen beoordelen van rapportages | Bewust worden van risico's |",
		].join("\n");
		const bytes = await renderPdf(parseBlocks(md), META);
		const doc = await PDFDocument.load(bytes);
		expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
		// Inflate the (Flate-compressed) content streams and check that the
		// wrapped fragments of the long cells survived — nothing truncated.
		const text = inflateContentStreams(bytes);
		expect(text).toContain("Strategisch");
		expect(text).toContain("datakwaliteit");
		expect(text).toContain("rapportages");
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
