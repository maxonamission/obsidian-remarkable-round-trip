import { describe, expect, it } from "vitest";
import {
	PARAGRAPH_STYLE,
	buildTextPageRm,
	readTextPageRm,
	type TextParagraph,
} from "../convert/rmtext";
import { RM_V6_HEADER } from "../incoming/rmlines";

const SAMPLE: TextParagraph[] = [
	{ text: "Band row", style: PARAGRAPH_STYLE.heading },
	{ text: "Krachtblok — trekken", style: PARAGRAPH_STYLE.bold },
	{ text: "Horizontale trekbeweging met een elastiek.", style: PARAGRAPH_STYLE.plain },
	{ text: "Elastiek op borsthoogte", style: PARAGRAPH_STYLE.bullet },
	{ text: "", style: PARAGRAPH_STYLE.plain },
	{ text: "2 × 15, rustig terug.", style: PARAGRAPH_STYLE.plain },
];

describe("v6 text page writer (GP_E7_S1)", () => {
	it("starts with the exact v6 header our stroke reader expects", () => {
		const bytes = buildTextPageRm(SAMPLE);
		const header = new TextDecoder().decode(bytes.subarray(0, RM_V6_HEADER.length));
		expect(header).toBe(RM_V6_HEADER);
	});

	it("round-trips paragraphs and styles through its own reader", () => {
		const { paragraphs, missing } = readTextPageRm(buildTextPageRm(SAMPLE));
		expect(missing).toBeUndefined();
		expect(paragraphs).toEqual(SAMPLE);
	});

	it("round-trips a single plain paragraph (the minimal page)", () => {
		const single: TextParagraph[] = [{ text: "alleen dit", style: PARAGRAPH_STYLE.plain }];
		expect(readTextPageRm(buildTextPageRm(single)).paragraphs).toEqual(single);
	});

	it("survives characters beyond ASCII (dashes, accents, ×)", () => {
		const unicode: TextParagraph[] = [
			{ text: "coördinatie — 2 × 30 s", style: PARAGRAPH_STYLE.plain },
		];
		expect(readTextPageRm(buildTextPageRm(unicode)).paragraphs).toEqual(unicode);
	});

	it("parses blocks the stroke reader also accepts (shared envelope)", () => {
		// The writer's block envelope must match what rmlines.ts walks:
		// uint32 length, unknown, minVersion, currentVersion, blockType.
		const bytes = buildTextPageRm(SAMPLE);
		const view = new DataView(bytes.buffer, RM_V6_HEADER.length);
		let offset = 0;
		const types: number[] = [];
		while (offset < view.byteLength) {
			const length = view.getUint32(offset, true);
			types.push(view.getUint8(offset + 7));
			offset += 8 + length;
		}
		expect(offset).toBe(view.byteLength); // envelopes line up exactly
		expect(types).toContain(0x07); // root text present
	});

	it("reports a page without text as missing instead of empty text", () => {
		// A page of pure ink has no root-text block; the reader must say so
		// rather than answer "empty document" (that difference decides whether
		// an import may overwrite the note, N5).
		const header = new TextEncoder().encode(RM_V6_HEADER);
		const empty = new Uint8Array(header.length);
		empty.set(header);
		expect(readTextPageRm(empty).missing).toBe(true);
	});
});
