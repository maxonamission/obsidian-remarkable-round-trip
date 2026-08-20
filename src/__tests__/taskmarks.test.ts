import { beforeAll, describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { PdfLayout, renderPdf } from "../convert/pdf";
import { readMarks } from "../incoming/marks";
import { projectOntoSource } from "../incoming/sourceprojection";
import {
	PAGE_HEIGHT as DEVICE_HEIGHT,
	PAGE_WIDTH as DEVICE_WIDTH,
	PAPER_PRO_GRID,
	RM2_GRID,
	deviceGridFor,
} from "../incoming/strokerender";
import { Stroke } from "../incoming/rmlines";
import type { ImportedMark } from "../incoming/pull";

/** A training checklist: the shape this feature exists for (GP_E5_S12). */
const LONG_TASK =
	"Uitgebreide mobiliteitsreeks doorlopen met alle varianten van de kuitrek en " +
	"de heuprotatie inclusief de extra herhalingen die de fysiotherapeut deze " +
	"week heeft toegevoegd aan het volledige programma van de maandagtraining";

const SOURCE = [
	"Afvinken na de training.",
	"",
	"- [ ] Warming-up vijf minuten",
	"- [ ] Band row twee keer vijftien",
	"- [x] Kuitrek beide kanten",
	"- [ ] Melk kopen",
	`- [ ] ${LONG_TASK}`,
	"- [ ] Push-ups veertig totaal",
	"\t- [ ] eerste set van acht",
	"\t- [ ] tweede set van acht",
	"- gewone bullet zonder taak",
].join("\n");

let layout: PdfLayout;

beforeAll(async () => {
	const rendered = await renderPdf(parseBlocks(SOURCE), {
		title: "Weeklog",
		docId: "d",
	});
	layout = rendered.layout;
});

const lineFor = (phrase: string) => {
	const line = layout.lines.find((candidate) => candidate.text.includes(phrase));
	if (line === undefined) throw new Error(`phrase not laid out: ${phrase}`);
	return line;
};

/** PDF points → the device grid the tablet writes its strokes in. */
const toDevice = (x: number, y: number) => ({
	x: (x * DEVICE_WIDTH) / layout.pageWidth - DEVICE_WIDTH / 2,
	y: ((layout.pageHeight - y) * DEVICE_HEIGHT) / layout.pageHeight,
});

function strokeThrough(points: { x: number; y: number }[], perPoint = 3): Stroke {
	const dense: { x: number; y: number }[] = [];
	for (let i = 1; i < points.length; i++) {
		const from = points[i - 1];
		const to = points[i];
		const steps = Math.max(2, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / perPoint));
		for (let step = 0; step < steps; step++) {
			const t = step / steps;
			dense.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
		}
	}
	dense.push(points[points.length - 1]);
	return {
		tool: 2,
		color: 0,
		thicknessScale: 1,
		points: dense.map((point) => ({ ...toDevice(point.x, point.y), width: 8, pressure: 100 })),
	};
}

/** A tick drawn inside the checkbox of the task line holding `phrase`. */
function tickIn(phrase: string): Stroke {
	const box = lineFor(phrase).checkbox;
	if (box === undefined) throw new Error(`no checkbox on: ${phrase}`);
	return strokeThrough([
		{ x: box.x + box.size * 0.2, y: box.y + box.size * 0.5 },
		{ x: box.x + box.size * 0.45, y: box.y + box.size * 0.2 },
		{ x: box.x + box.size * 0.9, y: box.y + box.size * 0.9 },
	]);
}

/**
 * A tick the way people actually draw one (device check 2026-08-19): a short
 * arm down to a vertex aimed at the box, then a tail sweeping two to three
 * text lines up and to the right — many times the size of the box itself.
 */
function naturalTickIn(phrase: string, vertexShift = { x: 0, y: 0 }): Stroke {
	const box = lineFor(phrase).checkbox;
	if (box === undefined) throw new Error(`no checkbox on: ${phrase}`);
	const step = lineFor(phrase).size * 1.5;
	const vertex = {
		x: box.x + box.size * 0.5 + vertexShift.x,
		y: box.y + box.size * 0.2 + vertexShift.y,
	};
	return strokeThrough([
		{ x: vertex.x - box.size * 0.8, y: vertex.y + box.size },
		vertex,
		{ x: vertex.x + step * 2.0, y: vertex.y + step * 2.6 },
	]);
}

describe("checkbox geometry in the layout map (GP_E5_S12)", () => {
	it("records a box on task lines, with the task's state", () => {
		const open = lineFor("Warming-up vijf minuten").checkbox;
		expect(open).toBeDefined();
		expect(open?.checked).toBe(false);
		expect(lineFor("Kuitrek beide kanten").checkbox?.checked).toBe(true);
	});

	it("places the box left of the text at three quarters of the type size", () => {
		const line = lineFor("Warming-up vijf minuten");
		expect(line.checkbox!.x).toBeLessThan(line.x);
		expect(line.checkbox!.size).toBeCloseTo(line.size * 0.75, 5);
	});

	it("records no box on ordinary bullets or paragraphs", () => {
		expect(lineFor("gewone bullet zonder taak").checkbox).toBeUndefined();
		expect(lineFor("Afvinken na de training").checkbox).toBeUndefined();
	});

	it("records a box on indented subtasks too", () => {
		const sub = lineFor("eerste set van acht");
		expect(sub.checkbox).toBeDefined();
		expect(sub.checkbox!.x).toBeLessThan(sub.x);
	});
});

describe("reading pen ticks (GP_E5_S12)", () => {
	it("reads a tick inside a box as a checkbox mark naming the task", () => {
		const marks = readMarks([tickIn("Warming-up vijf minuten")], 1, layout);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("checkbox");
		expect(marks[0].quote).toContain("Warming-up vijf minuten");
	});

	it("reads a cross in a box as ONE checkbox mark — shape is not judged", () => {
		const box = lineFor("Band row twee keer vijftien").checkbox!;
		const cross = [
			strokeThrough([
				{ x: box.x, y: box.y + box.size },
				{ x: box.x + box.size, y: box.y },
			]),
			strokeThrough([
				{ x: box.x, y: box.y },
				{ x: box.x + box.size, y: box.y + box.size },
			]),
		];
		const marks = readMarks(cross, 1, layout);
		// Two strokes, one gesture: joined per box (reviewvondst) so the
		// summary and the placed-count never report a tick twice.
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("checkbox");
		expect(marks[0].strokes).toHaveLength(2);
	});

	it("keeps a strike through the task text a strike-through, not a tick", () => {
		const line = lineFor("Band row twee keer vijftien");
		const first = line.words[0];
		const last = line.words[line.words.length - 1];
		const marks = readMarks(
			[
				strokeThrough([
					{ x: first.x, y: line.y + line.size * 0.35 },
					{ x: last.x + last.width, y: line.y + line.size * 0.35 },
				]),
			],
			1,
			layout,
		);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("strikethrough");
	});

	it("reads a natural tick with a long tail as a checkbox mark", () => {
		// The device check of 2026-08-19: three real ticks, all with tails
		// sweeping lines upward, all imported as note images. The bounding-box
		// centre hangs mid-tail far above the box, and the old size cap of 2.5
		// line steps rejected the gesture outright.
		const marks = readMarks([naturalTickIn("Warming-up vijf minuten")], 1, layout);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("checkbox");
		expect(marks[0].quote).toContain("Warming-up vijf minuten");
	});

	it("accepts a tick whose vertex lands just under the box", () => {
		const box = lineFor("Melk kopen").checkbox!;
		const marks = readMarks(
			[naturalTickIn("Melk kopen", { x: 0, y: -box.size * 0.6 })],
			1,
			layout,
		);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("checkbox");
		expect(marks[0].quote).toContain("Melk kopen");
	});

	it("resolves a tick between stacked subtasks to the nearest box", () => {
		const marks = readMarks([naturalTickIn("tweede set van acht")], 1, layout);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("checkbox");
		expect(marks[0].quote).toContain("tweede set van acht");
	});

	it("reads a cross larger than the box as ONE checkbox mark", () => {
		const box = lineFor("Band row twee keer vijftien").checkbox!;
		const reach = box.size * 1.6;
		const cross = [
			strokeThrough([
				{ x: box.x - box.size * 0.3, y: box.y + reach },
				{ x: box.x + reach, y: box.y - box.size * 0.3 },
			]),
			strokeThrough([
				{ x: box.x - box.size * 0.3, y: box.y - box.size * 0.3 },
				{ x: box.x + reach, y: box.y + reach },
			]),
		];
		const marks = readMarks(cross, 1, layout);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("checkbox");
		expect(marks[0].strokes).toHaveLength(2);
	});

	it("reads a compact tick in the margin LEFT of the box (field log 2026-08-19)", () => {
		// The week-01 field log: real ticks sat 10 to 40 points left of the
		// drawn box — in the page margin next to the item, where nothing else
		// lives. One scraped into the old window, its twins missed by points.
		const box = lineFor("Warming-up vijf minuten").checkbox!;
		const vertexX = box.x - 28;
		const marks = readMarks(
			[
				strokeThrough([
					{ x: vertexX - 3, y: box.y + box.size },
					{ x: vertexX, y: box.y + 1 },
					{ x: vertexX + 6, y: box.y + 14 },
				]),
			],
			1,
			layout,
		);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("checkbox");
		expect(marks[0].quote).toContain("Warming-up vijf minuten");
	});

	it("reads a one-line vertical dash in the margin at a task row as a tick", () => {
		// This exact stroke was classified as a margin quote in the field log
		// while its near-identical neighbour became a checkbox — the split
		// ran straight through the writer's habit.
		const box = lineFor("Melk kopen").checkbox!;
		const marks = readMarks(
			[
				strokeThrough([
					{ x: box.x - 18, y: box.y - 2 },
					{ x: box.x - 17, y: box.y + 11 },
				]),
			],
			1,
			layout,
		);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("checkbox");
		expect(marks[0].quote).toContain("Melk kopen");
	});

	it("keeps a tall margin bar spanning several task rows a margin quote", () => {
		const first = lineFor("Warming-up vijf minuten");
		const box = first.checkbox!;
		const step = first.size * 1.5;
		const marks = readMarks(
			[
				strokeThrough([
					{ x: box.x - 20, y: first.y - step * 2.2 },
					{ x: box.x - 19, y: first.y + step * 0.6 },
				]),
			],
			1,
			layout,
		);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("margin");
	});

	it("keeps a strike dipping lowest at the task's first word a strike", () => {
		// A strike-through's leftmost point sits close to the box; anchoring
		// on the lowest point must not turn a left-dipping strike into a tick.
		const line = lineFor("Band row twee keer vijftien");
		const first = line.words[0];
		const last = line.words[line.words.length - 1];
		const marks = readMarks(
			[
				strokeThrough([
					{ x: first.x, y: line.y + line.size * 0.3 },
					{ x: last.x + last.width, y: line.y + line.size * 0.45 },
				]),
			],
			1,
			layout,
		);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("strikethrough");
	});

	it("does not read a page-scale diagonal slash as a tick", () => {
		const line = lineFor("Band row twee keer vijftien");
		const box = line.checkbox!;
		const last = line.words[line.words.length - 1];
		const marks = readMarks(
			[
				strokeThrough([
					{ x: box.x, y: box.y },
					{ x: last.x + last.width, y: line.y + line.size * 4 },
				]),
			],
			1,
			layout,
		);
		expect(marks.every((mark) => mark.kind !== "checkbox")).toBe(true);
	});

	it("reads a flat stripe through a box as task CANCELLED (devicecheck 2026-08-20)", () => {
		// The PB field PDF: the owner's cancel gesture is a level stripe
		// straight through the box — a tenth of the box tall, nearly its
		// width. Before this, any ink on a box meant done.
		const box = lineFor("Band row twee keer vijftien").checkbox!;
		const marks = readMarks(
			[
				strokeThrough([
					{ x: box.x - 0.5, y: box.y + box.size * 0.45 },
					{ x: box.x + box.size + 1, y: box.y + box.size * 0.5 },
				]),
			],
			1,
			layout,
		);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("checkbox-cancel");
		expect(marks[0].quote).toContain("Band row twee keer vijftien");
	});

	it("joins a retraced stripe into ONE cancelled mark", () => {
		const box = lineFor("Melk kopen").checkbox!;
		const pass = (wobble: number) =>
			strokeThrough([
				{ x: box.x - 0.5, y: box.y + box.size * 0.45 + wobble },
				{ x: box.x + box.size + 1, y: box.y + box.size * 0.5 + wobble },
			]);
		const marks = readMarks([pass(0), pass(0.8)], 1, layout);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("checkbox-cancel");
		expect(marks[0].strokes).toHaveLength(2);
	});

	it("lets cancel win when one box carries a tick AND a stripe", () => {
		const box = lineFor("Melk kopen").checkbox!;
		const stripe = strokeThrough([
			{ x: box.x - 0.5, y: box.y + box.size * 0.45 },
			{ x: box.x + box.size + 1, y: box.y + box.size * 0.5 },
		]);
		const marks = readMarks([tickIn("Melk kopen"), stripe], 1, layout);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("checkbox-cancel");
	});

	it("keeps small ink away from any box a plain note", () => {
		const line = lineFor("Afvinken na de training");
		const word = line.words[1];
		const marks = readMarks(
			[
				strokeThrough([
					{ x: word.x, y: line.y - 2 },
					{ x: word.x + 4, y: line.y + 4 },
				]),
			],
			1,
			layout,
		);
		expect(marks.every((mark) => mark.kind !== "checkbox")).toBe(true);
	});
});

describe("task states in the annotated copy (GP_E5_S12)", () => {
	const idsOf = (phrase: string) => {
		const line = lineFor(phrase);
		return line.words.map((word) => word.id);
	};
	const project = (marks: ImportedMark[]) =>
		projectOntoSource({ source: SOURCE, layout, marks, highlights: [] });

	it("rewrites a ticked task to [x], leaving the rest of the line alone", () => {
		const result = project([
			{ kind: "checkbox", words: idsOf("Warming-up vijf minuten") },
		]);
		expect(result?.markdown).toContain("- [x] Warming-up vijf minuten");
		expect(result?.markdown).toContain("- [ ] Band row twee keer vijftien");
	});

	it("rewrites a fully struck task to [-] instead of striking its words", () => {
		const result = project([
			{ kind: "strikethrough", words: idsOf("Band row twee keer vijftien") },
		]);
		expect(result?.markdown).toContain("- [-] Band row twee keer vijftien");
		expect(result?.markdown).not.toContain("~~");
	});

	it("keeps a partial strike on a task line an inline strike", () => {
		const ids = idsOf("Band row twee keer vijftien").slice(0, 1);
		const result = project([{ kind: "strikethrough", words: ids }]);
		expect(result?.markdown).toContain("- [ ] ~~Band~~ row twee keer vijftien");
	});

	it("is idempotent on a task that was already done, and cancelled wins", () => {
		const both = project([
			{ kind: "checkbox", words: idsOf("Kuitrek beide kanten") },
			{ kind: "checkbox", words: idsOf("Band row twee keer vijftien") },
			{ kind: "strikethrough", words: idsOf("Band row twee keer vijftien") },
		]);
		expect(both?.markdown).toContain("- [x] Kuitrek beide kanten");
		expect(both?.markdown).toContain("- [-] Band row twee keer vijftien");
	});

	it("does not cancel a two-word task when only one word is struck", () => {
		const ids = idsOf("Melk kopen").slice(0, 1);
		const result = project([{ kind: "strikethrough", words: ids }]);
		expect(result?.markdown).toContain("- [ ] ~~Melk~~ kopen");
	});

	it("cancels a wrapped task struck with one gesture per visual row", () => {
		// A long task wraps to several PDF rows; each strike gesture covers
		// only its own row's words. Aggregated per source line they cover the
		// whole task, so it cancels (reviewvondst).
		const first = lineFor("Uitgebreide mobiliteitsreeks");
		const wrapped = layout.lines.filter((line) => line.block === first.block);
		expect(wrapped.length).toBeGreaterThan(1);
		const strikes = wrapped.map(
			(line): ImportedMark => ({
				kind: "strikethrough",
				words: line.words.map((word) => word.id),
			}),
		);
		const result = project(strikes);
		expect(result?.markdown).toContain(`- [-] ${LONG_TASK}`);
		expect(result?.markdown).not.toContain("~~");
	});

	it("ignores a checkbox mark whose words are not a task line", () => {
		const result = project([
			{ kind: "checkbox", words: idsOf("gewone bullet zonder taak") },
		]);
		expect(result?.markdown).toBe(SOURCE.trimEnd());
	});

	it("rewrites a stripe-cancelled task to [-]", () => {
		const result = project([
			{ kind: "checkbox-cancel", words: idsOf("Melk kopen") },
			{ kind: "checkbox", words: idsOf("Warming-up vijf minuten") },
		]);
		expect(result?.markdown).toContain("- [-] Melk kopen");
		expect(result?.markdown).toContain("- [x] Warming-up vijf minuten");
	});
});

describe("ticks on a Paper Pro page (GP_E5_S12, devicecheck 2026-08-20)", () => {
	// The field log that cracked it: every tick sat exactly on its box on the
	// tablet, yet imported 15% down-and-left of it — the Paper Pro writes ink
	// on a 1620×2160 grid, not the 1404×1872 the conversion assumed. The error
	// grows with the distance from the page's top-left, so a tick low on the
	// page drifted whole rows while one at the top merely scraped past.
	const PRO_SOURCE = [
		"Agendapunten tot nu toe:",
		"",
		"- [ ] test met vinkje",
		"- [ ] tweede agendapunt",
		"- [ ] derde agendapunt",
		"",
		...Array.from(
			{ length: 12 },
			(_, i) => `Tussenliggende alinea nummer ${i + 1} die de pagina vult.`,
		),
		"",
		"- [ ] onderaan eerste",
		"- [ ] onderaan tweede",
		"- [ ] onderaan derde",
	].join("\n");

	let proLayout: PdfLayout;

	beforeAll(async () => {
		const rendered = await renderPdf(
			parseBlocks(PRO_SOURCE),
			{ title: "PB", docId: "d" },
			// Paper Pro page in PDF points (1620×2160 px @ 229 dpi).
			{ pageWidth: 509, pageHeight: 679 },
		);
		proLayout = rendered.layout;
	});

	const proLineFor = (phrase: string) => {
		const line = proLayout.lines.find((candidate) => candidate.text.includes(phrase));
		if (line === undefined) throw new Error(`phrase not laid out: ${phrase}`);
		return line;
	};

	/** PDF points → the Paper Pro's own ink grid. */
	const toProDevice = (x: number, y: number) => ({
		x: (x * PAPER_PRO_GRID.width) / proLayout.pageWidth - PAPER_PRO_GRID.width / 2,
		y: ((proLayout.pageHeight - y) * PAPER_PRO_GRID.height) / proLayout.pageHeight,
	});

	const proStroke = (points: { x: number; y: number }[]): Stroke => ({
		tool: 2,
		color: 0,
		thicknessScale: 1,
		points: points.map((point) => ({
			...toProDevice(point.x, point.y),
			width: 8,
			pressure: 100,
		})),
	});

	/** The natural tick from the 2026-08-19 devicecheck, on a Paper Pro box. */
	const proTickIn = (phrase: string): Stroke => {
		const line = proLineFor(phrase);
		const box = line.checkbox;
		if (box === undefined) throw new Error(`no checkbox on: ${phrase}`);
		const step = line.size * 1.5;
		const vertex = { x: box.x + box.size * 0.5, y: box.y + box.size * 0.2 };
		return proStroke([
			{ x: vertex.x - box.size * 0.8, y: vertex.y + box.size },
			vertex,
			{ x: vertex.x + step * 2.0, y: vertex.y + step * 2.6 },
		]);
	};

	it("resolves the ink grid from the page size the PDF was typeset at", () => {
		expect(deviceGridFor(proLayout)).toBe(PAPER_PRO_GRID);
		expect(deviceGridFor(layout)).toBe(RM2_GRID);
		expect(deviceGridFor(null)).toBe(RM2_GRID);
	});

	it("reads a tick near the top of the page on the right task", () => {
		const marks = readMarks([proTickIn("test met vinkje")], 1, proLayout);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("checkbox");
		expect(marks[0].quote).toContain("test met vinkje");
	});

	it("reads a tick low on the page on ITS OWN row, not rows below", () => {
		// This is where the wrong grid hurt most: at two thirds down the page
		// the accumulated offset exceeded two line steps, so the tick was
		// attributed to a lower task or fell off the boxes entirely.
		const line = proLineFor("onderaan tweede");
		expect(toProDevice(0, line.y).y).toBeGreaterThan(PAPER_PRO_GRID.height / 2);
		const marks = readMarks([proTickIn("onderaan tweede")], 1, proLayout);
		expect(marks).toHaveLength(1);
		expect(marks[0].kind).toBe("checkbox");
		expect(marks[0].quote).toContain("onderaan tweede");
	});

	it("reads all three ticks of a stacked group on their own rows", () => {
		// The PB field note: three stacked tasks, three ticks, and the import
		// marked a different set done than the pen did.
		const phrases = ["onderaan eerste", "onderaan tweede", "onderaan derde"];
		const marks = readMarks(
			phrases.map((phrase) => proTickIn(phrase)),
			1,
			proLayout,
		);
		expect(marks).toHaveLength(3);
		for (const phrase of phrases) {
			expect(
				marks.some(
					(mark) => mark.kind === "checkbox" && mark.quote?.includes(phrase),
				),
			).toBe(true);
		}
	});

	it("reads the six PB gestures as done/cancelled/done — twice (field PDF 2026-08-20)", () => {
		// The exact scenario from the owner's PB_met_checkboxes PDF: per
		// group a tick, a flat stripe, and a cross/scribble — meaning
		// [x], [-], [x]. All six landed as [x] before the stripe rule.
		const stripeOn = (phrase: string): Stroke => {
			const box = proLineFor(phrase).checkbox!;
			return proStroke([
				{ x: box.x - 0.5, y: box.y + box.size * 0.45 },
				{ x: box.x + box.size + 1, y: box.y + box.size * 0.5 },
			]);
		};
		const crossOn = (phrase: string): Stroke[] => {
			const box = proLineFor(phrase).checkbox!;
			return [
				proStroke([
					{ x: box.x, y: box.y + box.size },
					{ x: box.x + box.size, y: box.y - 1 },
				]),
				proStroke([
					{ x: box.x, y: box.y - 1 },
					{ x: box.x + box.size, y: box.y + box.size },
				]),
			];
		};
		const marks = readMarks(
			[
				proTickIn("test met vinkje"),
				stripeOn("tweede agendapunt"),
				...crossOn("derde agendapunt"),
				stripeOn("onderaan eerste"),
				proTickIn("onderaan tweede"),
				...crossOn("onderaan derde"),
			],
			1,
			proLayout,
		);
		expect(marks).toHaveLength(6);
		const kindFor = (phrase: string) =>
			marks.find((mark) => mark.quote?.includes(phrase))?.kind;
		expect(kindFor("test met vinkje")).toBe("checkbox");
		expect(kindFor("tweede agendapunt")).toBe("checkbox-cancel");
		expect(kindFor("derde agendapunt")).toBe("checkbox");
		expect(kindFor("onderaan eerste")).toBe("checkbox-cancel");
		expect(kindFor("onderaan tweede")).toBe("checkbox");
		expect(kindFor("onderaan derde")).toBe("checkbox");
	});

	it("quotes handwriting beside a paragraph against that paragraph", () => {
		// The same grid feeds every anchor, so remarks moved with the ticks —
		// the earlier "three rows too low" placement was this bug too.
		const line = proLineFor("alinea nummer 8");
		const marginX = proLayout.pageWidth - 30;
		const marks = readMarks(
			[
				proStroke([
					{ x: marginX, y: line.y - line.size * 0.2 },
					{ x: marginX + 8, y: line.y + line.size * 0.6 },
					{ x: marginX + 16, y: line.y - line.size * 0.1 },
				]),
			],
			1,
			proLayout,
		);
		expect(marks).toHaveLength(1);
		expect(marks[0].quote).toContain("alinea nummer 8");
	});
});
