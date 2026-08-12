import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parseBlocks } from "../convert/mdblocks";
import {
	computeColumnWidths,
	parseTaskMarker,
	renderPdf,
	toWinAnsi,
	wrapText,
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
	it("keeps WinAnsi typography and falls back only for what WinAnsi lacks (GP_E5_S7)", () => {
		expect(toWinAnsi("a → b — 'x' … ≤5")).toBe("a -> b — 'x' … <=5");
		expect(toWinAnsi("‘q’ “r” – • s")).toBe("‘q’ “r” – • s");
	});

	it("replays the pre-0.29 ASCII fallbacks for typo-version-1 documents", () => {
		expect(toWinAnsi("a → b — 'x' … ≤5", 1)).toBe("a -> b -- 'x' ... <=5");
		expect(toWinAnsi("‘q’ “r” – • s", 1)).toBe("'q' \"r\" - - s");
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

describe("wrapText word breaking (GP_E5_S4)", () => {
	it("hard-breaks a word wider than the line, losing nothing", async () => {
		const doc = await PDFDocument.create();
		const font = await doc.embedFont(StandardFonts.Helvetica);
		const lines = wrapText("Achillespees", font, 10, 30);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(font.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(30);
		}
		expect(lines.join("")).toBe("Achillespees");
	});

	it("replays the old overflow for typo-version-1 layouts", async () => {
		const doc = await PDFDocument.create();
		const font = await doc.embedFont(StandardFonts.Helvetica);
		expect(wrapText("Achillespees", font, 10, 30, 1)).toEqual(["Achillespees"]);
	});
});

describe("parseTaskMarker (GP_E5_S6)", () => {
	it("recognises open and checked task markers", () => {
		expect(parseTaskMarker("[ ] Warming-up")).toEqual({ checked: false, rest: "Warming-up" });
		expect(parseTaskMarker("[x] Klaar")).toEqual({ checked: true, rest: "Klaar" });
		expect(parseTaskMarker("[X] Klaar")).toEqual({ checked: true, rest: "Klaar" });
	});

	it("keeps the number on ordered task items instead of swallowing it", async () => {
		const { bytes } = await renderPdf(parseBlocks("1. [ ] Taak\n2. [x] Klaar"), META, {});
		const content = inflateContentStreams(bytes);
		expect(content).toContain("1.");
		expect(content).toContain("[ ] Taak");
	});

	it("leaves plain items and mid-text brackets alone", () => {
		expect(parseTaskMarker("Warming-up [ ] later")).toBeNull();
		expect(parseTaskMarker("[y] geen taak")).toBeNull();
		expect(parseTaskMarker("gewone regel")).toBeNull();
	});
});

describe("renderPdf", () => {
	it("gives the document title a title's size, not the body's", async () => {
		// Regression (GP_E3_S15): between 0.11.0 and 0.16.0 the title was drawn
		// at heading level 0, which had no size of its own and fell through to
		// the 11 pt body size. That shrank the title block by 49.7 pt, so
		// rebuilding the layout of an earlier document put every row on page 1
		// fifty points too high and every pen mark three rows too low.
		const { layout } = await renderPdf(parseBlocks("Gewone alinea."), META);
		const title = layout.lines.find((line) => line.text.includes("Testnotitie"));
		expect(title?.size).toBe(19);
		expect(title?.role).toBe("title");
	});

	it("produces a valid PDF with reMarkable page size and docId metadata", async () => {
		const { bytes } = await renderPdf(parseBlocks("Eén alinea."), META);
		expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");

		const doc = await PDFDocument.load(bytes);
		expect(doc.getTitle()).toBe("Testnotitie");
		expect(doc.getSubject()).toBe(`${DOCID_SUBJECT_PREFIX}${META.docId}`);
		const page = doc.getPage(0);
		expect(Math.round(page.getWidth())).toBe(PAGE_WIDTH);
		expect(Math.round(page.getHeight())).toBe(PAGE_HEIGHT);
	});

	it("breaks long content across multiple pages", async () => {
		const longText = Array.from(
			{ length: 120 },
			(_, i) => `Alinea ${i} met wat tekst erbij.`,
		).join("\n\n");
		const { bytes } = await renderPdf(parseBlocks(longText), META);
		const doc = await PDFDocument.load(bytes);
		expect(doc.getPageCount()).toBeGreaterThan(1);
	});

	it("gives all-empty table rows writing height, unlike typo version 1 (GP_E5_S5)", async () => {
		const md = "| A | B |\n|---|---|\n| | |\n\nNa de tabel";
		const blocks = parseBlocks(md);
		const modern = await renderPdf(blocks, META, {});
		const legacy = await renderPdf(blocks, META, { typo: 1 });
		const after = (layoutLines: { text: string; y: number }[]) => {
			const line = layoutLines.find((l) => l.text.includes("Na de tabel"));
			if (!line) throw new Error("paragraph after table not laid out");
			return line.y;
		};
		// More vertical space consumed by the fill-in row pushes what follows down.
		expect(after(modern.layout.lines)).toBeLessThan(after(legacy.layout.lines));
	});

	it("renders a wide table without dropping cell content (wraps instead)", async () => {
		const md = [
			"| Doelgroep | Algemene leerdoelen | Kennis | Vaardigheden | Bewustzijn |",
			"|---|---|---|---|---|",
			"| Leidinggevenden | Strategisch sturen op datakwaliteit | Begrijpen van definities | Kunnen beoordelen van rapportages | Bewust worden van risico's |",
		].join("\n");
		const { bytes } = await renderPdf(parseBlocks(md), META);
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
		const { bytes } = await renderPdf(parseBlocks(md), META);
		expect(bytes.length).toBeGreaterThan(500);
	});
});
