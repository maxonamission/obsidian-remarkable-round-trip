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

	it("does not break a word that exactly fills its column (float noise)", async () => {
		// The real field case (0.29.0, "Achillespee/s"): a two-column table
		// whose first column is sized BY this word — the wrap width re-enters
		// as width-minus-plus-pad and lands 7e-15 pt under the word's width.
		const doc = await PDFDocument.create();
		const font = await doc.embedFont(StandardFonts.Helvetica);
		const word = "Achillespees";
		const maxWidth = font.widthOfTextAtSize(word, 10) + 8 - 8;
		expect(wrapText(word, font, 10, maxWidth)).toEqual([word]);
		// 0.29.0 uploads (typo 2) broke here, and must replay that way.
		expect(wrapText(word, font, 10, maxWidth, 2).length).toBeGreaterThan(1);
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

	it("gives label rows (only first column filled) writing height too", async () => {
		// The owner's log shape: "Slaap (uren) | " — a label with an empty
		// value cell to complete on the device (GP_E5_S5 follow-up, typo 3).
		const md = "| Veld | Waarde |\n|---|---|\n| Slaap (uren) | |\n\nNa de tabel";
		const blocks = parseBlocks(md);
		const modern = await renderPdf(blocks, META, {});
		const previous = await renderPdf(blocks, META, { typo: 2 });
		const after = (layoutLines: { text: string; y: number }[]) => {
			const line = layoutLines.find((l) => l.text.includes("Na de tabel"));
			if (!line) throw new Error("paragraph after table not laid out");
			return line.y;
		};
		// The label itself is still drawn...
		expect(modern.layout.lines.some((l) => l.text.includes("Slaap"))).toBe(true);
		// ...and the row consumes writing height, pushing what follows down.
		expect(after(modern.layout.lines)).toBeLessThan(after(previous.layout.lines));
	});

	it("starts a new page at a \\pagebreak marker (GP_E6_S1)", async () => {
		const { layout } = await renderPdf(
			parseBlocks("eerste\n\n\\pagebreak\n\ntweede"),
			META,
			{},
		);
		const pageOf = (text: string) =>
			layout.lines.find((l) => l.text.includes(text))?.page;
		expect(pageOf("eerste")).toBe(1);
		expect(pageOf("tweede")).toBe(2);
		expect(layout.pageCount).toBe(2);
	});

	it("does not leave a blank page after a trailing \\pagebreak", async () => {
		const { layout } = await renderPdf(parseBlocks("tekst\n\n\\pagebreak"), META, {});
		expect(layout.pageCount).toBe(1);
	});

	it("breaks the page before headings up to the configured level (GP_E6_S4)", async () => {
		const md = "# Dag 1\n\ntekst een\n\n## Sectie\n\ntekst twee\n\n### Detail\n\ntekst drie";
		const { layout } = await renderPdf(parseBlocks(md), META, { breakAtHeading: 2 });
		const pageOf = (text: string) => layout.lines.find((l) => l.text.includes(text))?.page;
		// The first heading right after the title stays put (no near-empty page 1).
		expect(pageOf("Dag 1")).toBe(1);
		expect(pageOf("Sectie")).toBe(2);
		expect(pageOf("tekst twee")).toBe(2);
		// ### is beyond the configured level and does not break.
		expect(pageOf("Detail")).toBe(2);
	});

	it("keeps every heading on one page with breakAtHeading off (default)", async () => {
		const md = "# Dag 1\n\ntekst een\n\n## Sectie\n\ntekst twee";
		const { layout } = await renderPdf(parseBlocks(md), META, {});
		expect(layout.pageCount).toBe(1);
	});

	it("moves a heading that would dangle at the page bottom along with its text (GP_E6_S5)", async () => {
		// A small page forces the situation deterministically: the paragraph
		// leaves room for the heading but not for any content under it.
		const filler = Array.from({ length: 6 }, (_, i) => `regel ${i}`).join("\n\n");
		const md = `${filler}\n\n## Kop\n\ndaaronder`;
		const { layout } = await renderPdf(parseBlocks(md), META, { pageHeight: 260 });
		const kop = layout.lines.find((l) => l.text.includes("Kop"));
		const text = layout.lines.find((l) => l.text.includes("daaronder"));
		expect(kop?.page).toBe(text?.page);
	});

	it("moves a table that fits on one page to a fresh page instead of splitting it (GP_E6_S5)", async () => {
		const filler = Array.from({ length: 5 }, (_, i) => `regel ${i}`).join("\n\n");
		const table = "| A | B |\n|---|---|\n| a1 | b1 |\n| a2 | b2 |\n| a3 | b3 |";
		const md = `${filler}\n\n${table}`;
		const modern = await renderPdf(parseBlocks(md), META, { pageHeight: 300 });
		const tablePages = new Set(
			modern.layout.lines.filter((l) => l.role === "table").map((l) => l.page),
		);
		expect(tablePages.size).toBe(1);
		// Typo 3 replay splits it, proving the fixture actually forces the case.
		const legacy = await renderPdf(parseBlocks(md), META, { pageHeight: 300, typo: 3 });
		const legacyPages = new Set(
			legacy.layout.lines.filter((l) => l.role === "table").map((l) => l.page),
		);
		expect(legacyPages.size).toBeGreaterThan(1);
	});

	it("draws a title-repeating first H1 only once (GP_E6_S6)", async () => {
		const md = "# Testnotitie\n\ntekst";
		const modern = await renderPdf(parseBlocks(md), META, {});
		const titled = modern.layout.lines.filter((l) => l.text.includes("Testnotitie"));
		expect(titled).toHaveLength(1);
		expect(titled[0].role).toBe("title");
		// Earlier uploads replay the duplicate, so their anchors hold.
		const legacy = await renderPdf(parseBlocks(md), META, { typo: 5 });
		expect(
			legacy.layout.lines.filter((l) => l.text.includes("Testnotitie")),
		).toHaveLength(2);
	});

	it("sizes the page to the chosen device screen (GP_E6_S2)", async () => {
		const { layout } = await renderPdf(
			parseBlocks("Een alinea voor de Paper Pro."),
			META,
			{ pageWidth: 509, pageHeight: 679 },
		);
		expect(layout.pageWidth).toBe(509);
		expect(layout.pageHeight).toBe(679);
		// Text starts at the top of the taller page, not at the rM2 height.
		const first = layout.lines[0];
		expect(first.y).toBeGreaterThan(596 - 40);
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
