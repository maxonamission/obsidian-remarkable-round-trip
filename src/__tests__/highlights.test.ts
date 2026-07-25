import { describe, expect, it } from "vitest";
import {
	colorName,
	isHighlightFile,
	pageIdFromHighlightPath,
	parseHighlightPage,
} from "../incoming/highlights";

const nested = JSON.stringify({
	highlights: [
		[
			{ text: "eerste highlight", color: 3, rects: [{ x: 1, y: 2, width: 3, height: 4 }] },
			{ text: "tweede", color: 4 },
		],
	],
});

describe("parseHighlightPage", () => {
	it("reads the nested layer format from the device", () => {
		expect(parseHighlightPage(nested)).toEqual([
			{ text: "eerste highlight", color: 3 },
			{ text: "tweede", color: 4 },
		]);
	});

	it("accepts a flat list too (firmware variation)", () => {
		const flat = JSON.stringify({ highlights: [{ text: "plat", color: 0 }] });
		expect(parseHighlightPage(flat)).toEqual([{ text: "plat", color: 0 }]);
	});

	it("tags highlights with the page number when given", () => {
		expect(parseHighlightPage(nested, 7).every((h) => h.page === 7)).toBe(true);
	});

	it("skips highlights without usable text (e.g. over an image)", () => {
		const json = JSON.stringify({
			highlights: [[{ color: 3, rects: [] }, { text: "   " }, { text: "goed" }]],
		});
		expect(parseHighlightPage(json)).toEqual([{ text: "goed" }]);
	});

	it("keeps unknown fields from breaking the parse", () => {
		const json = JSON.stringify({
			highlights: [[{ text: "ok", color: 3, nieuwVeld: { diep: true } }]],
			andereSleutel: 42,
		});
		expect(parseHighlightPage(json)).toEqual([{ text: "ok", color: 3 }]);
	});

	it("returns nothing for malformed or unrelated JSON instead of throwing", () => {
		expect(parseHighlightPage("{ niet echt json")).toEqual([]);
		expect(parseHighlightPage(JSON.stringify({ iets: "anders" }))).toEqual([]);
		expect(parseHighlightPage(JSON.stringify({ highlights: "geen lijst" }))).toEqual([]);
	});
});

describe("highlight file paths", () => {
	it("recognises highlight files and ignores other document files", () => {
		expect(isHighlightFile("abc.highlights/page-1.json")).toBe(true);
		expect(isHighlightFile("abc/page-1.rm")).toBe(false);
		expect(isHighlightFile("abc.content")).toBe(false);
	});

	it("extracts the page id for ordering", () => {
		expect(pageIdFromHighlightPath("abc.highlights/page-1.json")).toBe("page-1");
		expect(pageIdFromHighlightPath("abc.content")).toBeNull();
	});
});

describe("colorName", () => {
	it("maps the indices seen across firmware versions", () => {
		expect(colorName(0)).toBe("yellow");
		expect(colorName(4)).toBe("blue");
		expect(colorName(undefined)).toBeUndefined();
		expect(colorName(99)).toBeUndefined();
	});
});
