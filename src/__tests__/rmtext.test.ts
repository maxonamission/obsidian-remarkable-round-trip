import { describe, expect, it } from "vitest";
import {
	PARAGRAPH_STYLE,
	buildTextPageRm,
	buildTextPageRmItems,
	readTextPageRm,
	type CrdtId,
	type StyleSpec,
	type TextItemSpec,
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

/**
 * Pages that look like on-device edit histories (GP_E7_S3). Our writer emits
 * one item; the device's editor splits, appends and deletes items, anchored
 * by character id — the reader must reassemble the DOCUMENT order, not the
 * file order.
 */
describe("v6 reader against simulated device edits (GP_E7_S3)", () => {
	const id = (part1: number, part2: number): CrdtId => ({ part1, part2 });
	const START = id(0, 0);
	// The base document "Doel\nalles rustig" as one item, chars 16…32:
	// D=16 o=17 e=18 l=19 \n=20 a=21 …
	const BASE: TextItemSpec = { id: id(1, 16), left: START, right: START, text: "Doel\nalles rustig" };
	const STYLES: StyleSpec[] = [
		{ key: START, timestamp: id(1, 40), style: PARAGRAPH_STYLE.heading },
		{ key: id(1, 20), timestamp: id(1, 41), style: PARAGRAPH_STYLE.plain },
	];
	const texts = (bytes: Uint8Array) => readTextPageRm(bytes).paragraphs.map((p) => p.text);

	it("places a mid-paragraph insertion at its anchor, whatever the file order", () => {
		// Session edit: " heel" typed after "alles" (char 25 = the 's').
		// The device may store the new item anywhere in the file — the phone
		// app does exactly that (devicecheck 2026-08-19) — so placement runs
		// in passes until every anchor resolves.
		const insert: TextItemSpec = { id: id(2, 100), left: id(1, 25), right: id(1, 26), text: " heel" };
		const inOrder = buildTextPageRmItems([BASE, insert], STYLES);
		const outOfOrder = buildTextPageRmItems([insert, BASE], STYLES);
		expect(texts(inOrder)).toEqual(["Doel", "alles heel rustig"]);
		expect(texts(outOfOrder)).toEqual(["Doel", "alles heel rustig"]);
		expect(readTextPageRm(outOfOrder).unanchored).toBeUndefined();
	});

	it("places a phone-app edit between the halves of the item it split", () => {
		// The REAL topology from the 0.38.3 field diagnosis (devicecheck
		// 2026-08-19, "Racefietsonderhoud"): the app split the original item
		// at the edit point and the TAIL keeps the same left anchor as the
		// edit — only the right anchor ("I sit before char (0,20)") tells the
		// edit and the tail apart. Left-only placement sent the edit to the
		// end of the document, three device tests in a row.
		const items: TextItemSpec[] = [
			{ id: id(0, 16), left: START, right: START, text: "Voor" },
			{ id: id(1, 100), left: id(0, 19), right: id(0, 20), text: " en na" },
			{ id: id(0, 20), left: id(0, 19), right: START, text: " het poetsen" },
		];
		const styles: StyleSpec[] = [
			{ key: START, timestamp: id(1, 200), style: PARAGRAPH_STYLE.plain },
		];
		const result = readTextPageRm(buildTextPageRmItems(items, styles));
		expect(result.paragraphs).toEqual([
			{ text: "Voor en na het poetsen", style: PARAGRAPH_STYLE.plain },
		]);
		expect(result.unanchored).toBeUndefined();
	});

	it("resolves a chain of forward references across passes", () => {
		// A anchors into B, B anchors into the base — and the file stores
		// them in exactly the wrong order.
		const b: TextItemSpec = { id: id(2, 100), left: id(1, 32), right: START, text: " en" };
		const a: TextItemSpec = { id: id(3, 200), left: id(2, 102), right: START, text: " zo" };
		const bytes = buildTextPageRmItems([a, b, BASE], STYLES);
		expect(texts(bytes)).toEqual(["Doel", "alles rustig en zo"]);
	});

	it("falls back to the right anchor when the left one is gone", () => {
		// The left anchor points into a stretch the device cleaned up (no
		// item carries id (9,9) anymore); the right anchor still pins the
		// insert before "rustig" (char 27 = the 'r').
		const insert: TextItemSpec = { id: id(2, 100), left: id(9, 9), right: id(1, 27), text: "heel " };
		const bytes = buildTextPageRmItems([BASE, insert], STYLES);
		expect(texts(bytes)).toEqual(["Doel", "alles heel rustig"]);
		expect(readTextPageRm(bytes).unanchored).toBeUndefined();
	});

	it("prepends an item anchored between document start and the first character", () => {
		const insert: TextItemSpec = { id: id(2, 100), left: START, right: id(1, 16), text: "Mijn " };
		const bytes = buildTextPageRmItems([BASE, insert], STYLES);
		expect(texts(bytes)[0]).toBe("Mijn Doel");
	});

	it("appends unresolvable items at the end and counts them, never dropping text", () => {
		const lost: TextItemSpec = { id: id(2, 100), left: id(9, 9), right: id(8, 8), text: "zwevend" };
		const result = readTextPageRm(buildTextPageRmItems([BASE, lost], STYLES));
		expect(result.unanchored).toBe(1);
		expect(result.paragraphs.map((p) => p.text).join("\n")).toContain("zwevend");
	});

	it("merges paragraphs when a deletion spans the newline between them", () => {
		// The device deletes chars 19-21 ("l\na"): the newline goes, and the
		// second paragraph's style key (the newline, id 20) now points at a
		// deleted character. Deleted stretch = separate item, original item
		// split around it — the shape rmscene documents.
		const items: TextItemSpec[] = [
			{ id: id(1, 16), left: START, right: START, text: "Doe" },
			{ id: id(1, 19), left: id(1, 18), right: id(1, 22), deletedLength: 3 },
			{ id: id(1, 22), left: id(1, 21), right: START, text: "lles rustig" },
		];
		const { paragraphs } = readTextPageRm(buildTextPageRmItems(items, STYLES));
		expect(paragraphs).toEqual([
			{ text: "Doelles rustig", style: PARAGRAPH_STYLE.heading },
		]);
	});

	it("stacks several editing sessions: append, then insert into the appended text", () => {
		// Session 1 appends a new paragraph after "…rustig" (char 32); session
		// 2 inserts into THAT paragraph, anchored to session 1's chars.
		const session1: TextItemSpec = { id: id(2, 100), left: id(1, 32), right: START, text: "\nnwe regel" };
		const session2: TextItemSpec = { id: id(3, 200), left: id(2, 101), right: id(2, 102), text: "ieu" };
		const bytes = buildTextPageRmItems(
			[BASE, session1, session2],
			[...STYLES, { key: id(2, 100), timestamp: id(1, 42), style: PARAGRAPH_STYLE.bullet }],
		);
		const { paragraphs } = readTextPageRm(bytes);
		expect(paragraphs).toEqual([
			{ text: "Doel", style: PARAGRAPH_STYLE.heading },
			{ text: "alles rustig", style: PARAGRAPH_STYLE.plain },
			{ text: "nieuwe regel", style: PARAGRAPH_STYLE.bullet },
		]);
	});

	it("refuses a page where two items claim the same character ids", () => {
		// Ids are unique by construction on a real device; overlap means a
		// corrupt or crafted page, and anchoring into it could silently
		// reorder the text. Loud failure → the import writes nothing
		// (security-review 2026-08-19).
		const overlapping: TextItemSpec[] = [
			BASE,
			{ id: id(1, 20), left: id(1, 32), right: START, text: "boze tekst" },
		];
		expect(() => readTextPageRm(buildTextPageRmItems(overlapping, STYLES))).toThrow(
			/same character/,
		);
	});

	it("anchors to a character that was deleted in a later session", () => {
		// Session 1 inserts after char 19 ("l"); session 2 deletes chars 17-19
		// ("oel"). The anchor target is gone from the text but must stay in
		// the sequence, or session 1's insert would drift to the end.
		const items: TextItemSpec[] = [
			{ id: id(1, 16), left: START, right: START, text: "D" },
			{ id: id(1, 17), left: id(1, 16), right: id(1, 20), deletedLength: 3 },
			{ id: id(1, 20), left: id(1, 19), right: START, text: "\nalles rustig" },
			{ id: id(2, 100), left: id(1, 19), right: id(1, 20), text: "it" },
		];
		const { paragraphs } = readTextPageRm(buildTextPageRmItems(items, STYLES));
		expect(paragraphs.map((p) => p.text)).toEqual(["Dit", "alles rustig"]);
	});
});
