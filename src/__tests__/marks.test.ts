import { beforeAll, describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { LaidOutLine, PdfLayout, renderPdf } from "../convert/pdf";
import { readMarks } from "../incoming/marks";
import {
	PAGE_HEIGHT as DEVICE_HEIGHT,
	PAGE_WIDTH as DEVICE_WIDTH,
} from "../incoming/strokerender";
import { Stroke } from "../incoming/rmlines";

const MARKDOWN = [
	"De combinatie van die twee perspectieven blijkt goed te werken bij ons.",
	"",
	"Hierbij kun je denken aan dataopslag, de ontwikkeling van algoritmes,",
	"applicatiebouw en de integratie tussen deze losse componenten onderling.",
	"",
	"Erik: voor mij waren dat vooral learnings over hoe om te gaan met data.",
].join("\n");

let layout: PdfLayout;

beforeAll(async () => {
	const rendered = await renderPdf(parseBlocks(MARKDOWN), {
		title: "Testnotitie",
		docId: "d",
	});
	layout = rendered.layout;
});

/** PDF points → the device grid the tablet writes its strokes in. */
const toDevice = (x: number, y: number) => ({
	x: (x * DEVICE_WIDTH) / layout.pageWidth - DEVICE_WIDTH / 2,
	y: ((layout.pageHeight - y) * DEVICE_HEIGHT) / layout.pageHeight,
});

/**
 * A stroke through the given PDF-space polyline. Sampled by distance, the way
 * a pen does: a short arrowhead gets few points, a long shaft many.
 */
function strokeThrough(points: { x: number; y: number }[], perPoint = 3): Stroke {
	const dense: { x: number; y: number }[] = [];
	for (let i = 1; i < points.length; i++) {
		const from = points[i - 1];
		const to = points[i];
		const steps = Math.max(2, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / perPoint));
		for (let step = 0; step < steps; step++) {
			const t = step / steps;
			dense.push({
				x: from.x + (to.x - from.x) * t,
				y: from.y + (to.y - from.y) * t,
			});
		}
	}
	dense.push(points[points.length - 1]);
	return {
		tool: 2,
		color: 0,
		thicknessScale: 1,
		points: dense.map((point) => ({
			...toDevice(point.x, point.y),
			width: 8,
			pressure: 100,
		})),
	};
}

/** The laid-out line holding a phrase, plus the span its words occupy. */
function spanOf(phrase: string): {
	line: LaidOutLine;
	from: number;
	to: number;
} {
	const words = phrase.split(" ");
	const line = layout.lines.find((candidate) => candidate.text.includes(phrase));
	if (line === undefined) throw new Error(`phrase not laid out: ${phrase}`);
	const first = line.words.find((word) => word.text === words[0]);
	const last = [...line.words].reverse().find((word) => word.text === words[words.length - 1]);
	if (first === undefined || last === undefined) throw new Error(`words not found: ${phrase}`);
	return { line, from: first.x, to: last.x + last.width };
}

describe("readMarks", () => {
	it("reads a line through words as a strike-through, and names the words", () => {
		const { line, from, to } = spanOf("algoritmes,");
		const y = line.y + line.size * 0.35;
		const marks = readMarks(
			[
				strokeThrough([
					{ x: from, y },
					{ x: to, y },
				]),
			],
			line.page,
			layout,
		);

		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("strikethrough");
		expect(marks[0].target).toContain("algoritmes,");
	});

	it("reads a line under words as an underline", () => {
		const { line, from, to } = spanOf("de ontwikkeling van");
		const y = line.y - line.size * 0.1;
		const marks = readMarks(
			[
				strokeThrough([
					{ x: from, y },
					{ x: to, y },
				]),
			],
			line.page,
			layout,
		);

		expect(marks[0].kind).toBe("underline");
		expect(marks[0].target).toBe("de ontwikkeling van");
	});

	it("reads a loop around words as a circle", () => {
		const { line, from, to } = spanOf("vooral learnings");
		const top = line.y + line.size * 0.9;
		const bottom = line.y - line.size * 0.4;
		const middle = (from + to) / 2;
		const marks = readMarks(
			[
				strokeThrough([
					{ x: from, y: line.y },
					{ x: middle, y: top },
					{ x: to, y: line.y },
					{ x: middle, y: bottom },
					{ x: from, y: line.y },
				]),
			],
			line.page,
			layout,
		);

		expect(marks[0].kind).toBe("circle");
		expect(marks[0].target).toContain("learnings");
	});

	it("reads a bar beside the text as a margin mark and quotes those lines", () => {
		const line = layout.lines.find((candidate) => candidate.text.includes("Hierbij kun je"));
		if (line === undefined) throw new Error("line not laid out");
		// Left of the text column, spanning one line.
		const marks = readMarks(
			[
				strokeThrough([
					{ x: 26, y: line.y + line.size },
					{ x: 26, y: line.y - line.size * 0.4 },
				]),
			],
			line.page,
			layout,
		);

		expect(marks[0].kind).toBe("margin");
		expect(marks[0].quote).toContain("Hierbij kun je");
	});

	it("reads a stroke that doubles back on itself as an arrow", () => {
		const { line, from, to } = spanOf("applicatiebouw en de");
		const y = line.y + line.size * 1.6; // above the line, pointing down at it
		const marks = readMarks(
			[
				strokeThrough([
					{ x: from, y },
					{ x: to, y: line.y + line.size * 0.3 },
					{ x: to - 8, y: line.y + line.size * 0.9 },
				]),
			],
			line.page,
			layout,
		);

		expect(marks[0].kind).toBe("arrow");
	});

	it("keeps unrecognised ink as a note, with the line it sits against", () => {
		const line = layout.lines.find((candidate) => candidate.text.includes("Erik:"));
		if (line === undefined) throw new Error("line not laid out");
		// A short scribble in the empty space right of the text.
		const scribble = strokeThrough([
			{ x: 300, y: line.y },
			{ x: 306, y: line.y + 6 },
			{ x: 300, y: line.y + 3 },
		]);
		const marks = readMarks([scribble], line.page, layout);

		expect(marks[0].kind).toBe("note");
		expect(marks[0].quote).toContain("Erik:");
		expect(marks[0].strokes).toHaveLength(1);
	});

	it("keeps two marks on one line apart", () => {
		// The beta case: an underline and a strike-through side by side on the
		// same row must not merge into one blob.
		const { line, from, to } = spanOf("de ontwikkeling van");
		const struck = spanOf("algoritmes,");
		const marks = readMarks(
			[
				strokeThrough([
					{ x: from, y: line.y - line.size * 0.1 },
					{ x: to, y: line.y - line.size * 0.1 },
				]),
				strokeThrough([
					{ x: struck.from, y: line.y + line.size * 0.35 },
					{ x: struck.to, y: line.y + line.size * 0.35 },
				]),
			],
			line.page,
			layout,
		);

		expect(marks.map((mark) => mark.kind).sort()).toEqual(["strikethrough", "underline"]);
	});

	it("treats everything as a note when there is no layout to compare against", () => {
		const { line, from, to } = spanOf("algoritmes,");
		const y = line.y + line.size * 0.35;
		const marks = readMarks(
			[
				strokeThrough([
					{ x: from, y },
					{ x: to, y },
				]),
			],
			1,
			null,
		);

		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("note");
		expect(marks[0].quote).toBeUndefined();
	});

	it("returns nothing for a page without ink", () => {
		expect(readMarks([], 1, layout)).toEqual([]);
	});
});
