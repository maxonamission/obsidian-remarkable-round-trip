import { describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { PdfLayout, renderPdf } from "../convert/pdf";
import {
	Bounds,
	clusterStrokes,
	deviceBoundsToPdf,
	quoteForInk,
	strokeBounds,
} from "../incoming/anchor";
import { PAGE_HEIGHT as DEVICE_HEIGHT } from "../incoming/strokerender";
import { Stroke } from "../incoming/rmlines";

const stroke = (points: { x: number; y: number }[]): Stroke => ({
	tool: 2,
	color: 0,
	thicknessScale: 1,
	points: points.map((point) => ({ ...point, width: 10, pressure: 100 })),
});

/** Device y that lands on a given PDF baseline. */
const deviceYForPdfY = (pdfY: number, layout: PdfLayout) =>
	((layout.pageHeight - pdfY) * DEVICE_HEIGHT) / layout.pageHeight;

describe("strokeBounds", () => {
	it("ignores non-finite points instead of poisoning the bounds", () => {
		const bounds = strokeBounds([
			stroke([
				{ x: 0, y: 0 },
				{ x: NaN, y: 5 },
				{ x: 10, y: 20 },
			]),
		]);
		expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 20 });
	});

	it("returns null when there is no usable ink", () => {
		expect(strokeBounds([])).toBeNull();
	});
});

describe("clusterStrokes", () => {
	it("keeps the lines of one remark together", () => {
		const clusters = clusterStrokes([
			stroke([
				{ x: 0, y: 100 },
				{ x: 50, y: 110 },
			]),
			stroke([
				{ x: 0, y: 150 },
				{ x: 50, y: 160 },
			]),
		]);
		expect(clusters).toHaveLength(1);
		expect(clusters[0].bounds).toMatchObject({ minY: 100, maxY: 160 });
	});

	it("splits remarks that sit far apart on the page", () => {
		const clusters = clusterStrokes([
			stroke([{ x: 0, y: 100 }]),
			stroke([{ x: 0, y: 900 }]),
			stroke([{ x: 20, y: 940 }]),
		]);
		expect(clusters).toHaveLength(2);
		expect(clusters[1].strokes).toHaveLength(2);
	});

	it("orders clusters down the page, whatever order the strokes arrived in", () => {
		const clusters = clusterStrokes([stroke([{ x: 0, y: 900 }]), stroke([{ x: 0, y: 100 }])]);
		expect(clusters.map((c) => c.bounds.minY)).toEqual([100, 900]);
	});
});

describe("deviceBoundsToPdf", () => {
	const layout: PdfLayout = { pageWidth: 447, pageHeight: 596, pageCount: 1, lines: [] };

	it("centres x and flips y", () => {
		const device: Bounds = { minX: -702, minY: 0, maxX: 702, maxY: 1872 };
		const pdf = deviceBoundsToPdf(device, layout);
		expect(pdf.minX).toBeCloseTo(0, 5);
		expect(pdf.maxX).toBeCloseTo(447, 5);
		expect(pdf.minY).toBeCloseTo(0, 5);
		expect(pdf.maxY).toBeCloseTo(596, 5);
	});
});

describe("quoteForInk", () => {
	const markdown = [
		"De eerste alinea gaat over iets heel anders dan de tweede.",
		"",
		"Vertrouwen in data begint bij een gedeelde definitie van kwaliteit.",
		"",
		"En de derde alinea sluit het geheel af met een losse gedachte.",
	].join("\n");

	async function layoutOf(): Promise<PdfLayout> {
		const { layout } = await renderPdf(parseBlocks(markdown), {
			title: "Testnotitie",
			docId: "doc-1",
		});
		return layout;
	}

	it("quotes the line the ink was written next to", async () => {
		const layout = await layoutOf();
		const target = layout.lines.find((line) => line.text.includes("Vertrouwen in data"));
		expect(target).toBeDefined();

		const y = deviceYForPdfY(target!.y, layout);
		// A margin note: to the right of the text, at the same height.
		const ink: Bounds = { minX: 400, minY: y - 20, maxX: 650, maxY: y + 20 };
		expect(quoteForInk(ink, target!.page, layout)).toContain("Vertrouwen in data");
	});

	it("reaches the line above when the ink sits just under it, as an underline does", async () => {
		const layout = await layoutOf();
		const target = layout.lines.find((line) => line.text.includes("Vertrouwen in data"));
		const y = deviceYForPdfY(target!.y, layout);
		const ink: Bounds = { minX: -600, minY: y + 12, maxX: 200, maxY: y + 20 };
		expect(quoteForInk(ink, target!.page, layout)).toContain("Vertrouwen in data");
	});

	it("says nothing when the ink is nowhere near any text", async () => {
		const layout = await layoutOf();
		// Bottom of the page: this note is short, so there is only white there.
		const ink: Bounds = { minX: -600, minY: 1750, maxX: 600, maxY: 1850 };
		expect(quoteForInk(ink, 1, layout)).toBeUndefined();
	});

	it("says nothing for a page that holds no text at all", async () => {
		const layout = await layoutOf();
		expect(quoteForInk({ minX: 0, minY: 100, maxX: 10, maxY: 120 }, 9, layout)).toBeUndefined();
	});

	it("truncates a quote that would swamp the note", async () => {
		const layout = await layoutOf();
		const target = layout.lines.find((line) => line.text.includes("Vertrouwen in data"));
		const y = deviceYForPdfY(target!.y, layout);
		const ink: Bounds = { minX: 400, minY: y - 20, maxX: 650, maxY: y + 20 };
		const quote = quoteForInk(ink, target!.page, layout, { maxChars: 20 });
		expect(quote).toHaveLength(21); // 20 characters plus the ellipsis
		expect(quote?.endsWith("…")).toBe(true);
	});
});
