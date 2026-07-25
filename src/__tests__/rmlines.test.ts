import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRmV6, parseRmLines, RM_V6_HEADER } from "../incoming/rmlines";

/** A real v6 page from rmscene's test data (MIT) — see fixtures/README.md. */
const realPage = new Uint8Array(
	readFileSync(fileURLToPath(new URL("./fixtures/lines-v2.rm", import.meta.url))),
);

describe("parseRmLines against a real v6 page", () => {
	const strokes = parseRmLines(realPage);

	it("recognises the v6 header", () => {
		expect(isRmV6(realPage)).toBe(true);
		expect(isRmV6(new Uint8Array([1, 2, 3]))).toBe(false);
	});

	it("finds the drawn strokes", () => {
		expect(strokes).toHaveLength(10);
		expect(strokes.every((s) => s.points.length > 0)).toBe(true);
	});

	it("reads plausible pen metadata", () => {
		for (const stroke of strokes) {
			expect(stroke.thicknessScale).toBeGreaterThan(0);
			expect(Number.isInteger(stroke.tool)).toBe(true);
			expect(Number.isInteger(stroke.color)).toBe(true);
		}
	});

	it("reads coordinates inside the device's drawing area", () => {
		const points = strokes.flatMap((s) => s.points);
		expect(points.length).toBeGreaterThan(300);
		// reMarkable pages are ~1404x1872 with x centred on zero.
		for (const point of points) {
			expect(Math.abs(point.x)).toBeLessThan(1500);
			expect(point.y).toBeGreaterThan(-1500);
			expect(point.y).toBeLessThan(3000);
			expect(Number.isFinite(point.width)).toBe(true);
		}
	});

	it("consumes the file without drifting out of alignment", () => {
		// Misreading any field would desynchronise the block walk and lose
		// strokes; a full, exact stroke count is the canary for that.
		const truncated = parseRmLines(realPage.slice(0, realPage.length - 200));
		expect(truncated.length).toBeLessThanOrEqual(strokes.length);
	});
});

describe("parseRmLines robustness", () => {
	it("returns nothing for files that are not v6", () => {
		expect(parseRmLines(new Uint8Array(0))).toEqual([]);
		expect(parseRmLines(new TextEncoder().encode("reMarkable .lines file, version=5"))).toEqual(
			[],
		);
	});

	it("survives a truncated block header without throwing", () => {
		const bytes = new Uint8Array(RM_V6_HEADER.length + 3);
		for (let i = 0; i < RM_V6_HEADER.length; i++) bytes[i] = RM_V6_HEADER.charCodeAt(i);
		expect(parseRmLines(bytes)).toEqual([]);
	});

	it("ignores a block whose declared length runs past the file", () => {
		const bytes = new Uint8Array(RM_V6_HEADER.length + 8);
		for (let i = 0; i < RM_V6_HEADER.length; i++) bytes[i] = RM_V6_HEADER.charCodeAt(i);
		new DataView(bytes.buffer).setUint32(RM_V6_HEADER.length, 9999, true);
		expect(parseRmLines(bytes)).toEqual([]);
	});
});
