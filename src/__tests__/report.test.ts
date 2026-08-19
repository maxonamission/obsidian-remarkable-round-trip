import { describe, expect, it } from "vitest";
import { PullResult } from "../incoming/pull";
import { renderImportReport } from "../incoming/report";

const base = {
	forced: false,
	startedAt: "2026-07-25 22:30",
	pluginVersion: "0.6.0",
};

const scan = (over: Partial<NonNullable<Extract<PullResult, { ok: true }>["scan"]>> = {}) => ({
	totalFiles: 5,
	highlightFiles: 0,
	strokeFiles: 0,
	parsedHighlights: 0,
	unreadableFiles: 0,
	renderedPages: 0,
	renderedRemarks: 0,
	anchoredRemarks: 0,
	interpretedMarks: 0,
	highlightsInStrokes: 0,
	addedPages: 0,
	...over,
});

describe("renderImportReport", () => {
	it("says plainly when nothing has been sent yet", () => {
		expect(renderImportReport({ ...base, results: [] })).toContain("nothing to import");
	});

	it("points at the setting when strokes were found but handwriting import is off", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 0,
				scan: scan({ strokeFiles: 3 }),
			},
		];
		const report = renderImportReport({
			...base,
			handwritingEnabled: false,
			results,
		});
		expect(report).toContain("pen strokes but no text highlights");
		expect(report).toContain("switched off");
		expect(report).toContain("5 files, 0 highlight, 3 stroke");
	});

	it("does not claim handwriting import is missing when strokes rendered nothing", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 0,
				scan: scan({ strokeFiles: 3 }),
			},
		];
		const report = renderImportReport({
			...base,
			handwritingEnabled: true,
			results,
		});
		expect(report).not.toContain("not built yet");
		expect(report).toContain("could not be rendered");
	});

	it("reports rendered handwriting as a success, even without highlights", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 0,
				scan: scan({
					strokeFiles: 1,
					renderedPages: 1,
					renderedRemarks: 1,
					anchoredRemarks: 1,
				}),
			},
		];
		const report = renderImportReport({
			...base,
			handwritingEnabled: true,
			results,
		});
		expect(report).toContain("1 pen mark(s) on 1 page(s), 1 tied to the source");
		expect(report).toContain("1 page(s) with pen marks came back");
		expect(report).not.toContain("not built yet");
	});

	it("mentions handwriting alongside imported highlights", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 2,
				scan: scan({
					highlightFiles: 1,
					parsedHighlights: 2,
					strokeFiles: 2,
					renderedPages: 2,
					renderedRemarks: 3,
				}),
			},
		];
		const report = renderImportReport({
			...base,
			handwritingEnabled: true,
			results,
		});
		expect(report).toContain("Imported successfully");
		expect(report).toContain("2 page(s) with pen marks came back");
	});

	it("says what ended up in the vault, copy or summary", () => {
		// Beta 2026-07-27: the projection fell back silently, so a run that
		// wrote a summary read as a successful import that did nothing.
		const copy: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 1,
				scan: scan({ written: { form: "copy", unplaced: 0 } }),
			},
		];
		expect(renderImportReport({ ...base, results: copy })).toContain(
			"written as: annotated copy of the note",
		);

		const fell: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 1,
				scan: scan({ written: { form: "summary", reason: "no-alignment" } }),
			},
		];
		const report = renderImportReport({ ...base, results: fell });
		expect(report).toContain("written as: summary");
		expect(report).toContain("could not be lined up with the note");
	});

	it("names the reason a summary was written", () => {
		const changed: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 1,
				scan: scan({ written: { form: "summary", reason: "no-layout" } }),
			},
		];
		expect(renderImportReport({ ...base, results: changed })).toContain(
			"the note changed since it was sent",
		);
	});

	it("names a note that changed after it was sent (F14)", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 2,
				scan: scan({
					sourceState: "changed",
					written: { form: "summary", reason: "no-layout" },
				}),
			},
		];
		const report = renderImportReport({ ...base, results });
		expect(report).toContain("source note: changed since it was sent");
		expect(report).toContain("Send it again");
	});

	it("says a moved note was found again, and stays quiet about an unchanged one", () => {
		const moved: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Map/Nota.md",
				highlightCount: 1,
				scan: scan({ sourceState: "moved" }),
			},
		];
		expect(renderImportReport({ ...base, results: moved })).toContain(
			"found again by its document id",
		);

		const same: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 1,
				scan: scan({ sourceState: "match" }),
			},
		];
		expect(renderImportReport({ ...base, results: same })).not.toContain("source note:");
	});

	it("blames the edit, not EPUB, when the source check knows the note changed", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 0,
				scan: scan({
					strokeFiles: 1,
					renderedPages: 1,
					renderedRemarks: 2,
					anchorSkipped: "no-layout",
					sourceState: "changed",
				}),
			},
		];
		const report = renderImportReport({ ...base, handwritingEnabled: true, results });
		expect(report).toContain("has been edited since it was sent");
		expect(report).not.toContain("or it went over as EPUB");
	});

	it("mentions pages the reader added on the device", () => {
		// GP_E3_S20: the reMarkable can insert a blank page into a PDF to write
		// on; until now that page came back as loose drawings anchored to
		// whatever happened to sit at those coordinates in the source.
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 0,
				scan: scan({
					strokeFiles: 3,
					renderedPages: 1,
					renderedRemarks: 1,
					anchoredRemarks: 1,
					addedPages: 1,
				}),
			},
		];
		const report = renderImportReport({ ...base, handwritingEnabled: true, results });
		expect(report).toContain("1 page(s) you added on the device");
		expect(report).toContain("came back whole, placed after the text they follow");
	});

	it("says when the highlights came from the pen layer", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 3,
				scan: scan({ strokeFiles: 2, parsedHighlights: 3, highlightsInStrokes: 3 }),
			},
		];
		expect(renderImportReport({ ...base, results })).toContain(
			"3 highlight(s) (from the pen layer)",
		);
	});

	it("names the marks it could read as text", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 0,
				scan: scan({
					strokeFiles: 1,
					renderedPages: 1,
					renderedRemarks: 3,
					interpretedMarks: 2,
					anchoredRemarks: 3,
				}),
			},
		];
		const report = renderImportReport({
			...base,
			handwritingEnabled: true,
			results,
		});
		expect(report).toContain("3 pen mark(s) on 1 page(s), 2 read as text");
		expect(report).toContain("2 of them were read as text");
	});

	it("explains why the handwriting could not be quoted", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 0,
				scan: scan({
					strokeFiles: 1,
					renderedPages: 1,
					renderedRemarks: 1,
					anchorSkipped: "no-layout",
				}),
			},
		];
		const report = renderImportReport({
			...base,
			handwritingEnabled: true,
			results,
		});
		expect(report).toContain("could not be quoted against the source text");
		expect(report).toContain("Send the note again");
	});

	it("points at an unrecognised format when highlight files yield nothing", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 0,
				scan: scan({ highlightFiles: 2 }),
			},
		];
		expect(renderImportReport({ ...base, results })).toContain("firmware format");
	});

	it("suggests a forced re-import when everything was skipped", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 0,
				skipped: true,
				skipReason: "unchanged",
			},
		];
		const report = renderImportReport({ ...base, results });
		expect(report).toContain("unchanged since the last import");
		expect(report).toContain("Re-import all annotations");
	});

	it("names a write-mode document as out of scope for the annotation import", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 0,
				skipped: true,
				skipReason: "write-mode",
			},
		];
		expect(renderImportReport({ ...base, results })).toContain(
			"sent as editable text",
		);
	});

	it("distinguishes a document that is no longer on the account", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 0,
				skipped: true,
				skipReason: "not-on-device",
			},
		];
		expect(renderImportReport({ ...base, results })).toContain("no longer on the reMarkable");
	});

	it("names the cause when every document failed", () => {
		const auth: PullResult[] = [{ ok: false, docId: "a", notePath: "Nota.md", error: "401" }];
		expect(renderImportReport({ ...base, results: auth })).toContain("Pair again");

		const offline: PullResult[] = [
			{ ok: false, docId: "a", notePath: "Nota.md", error: "Unable to resolve host" },
		];
		expect(renderImportReport({ ...base, results: offline })).toContain(
			"network problem, not your pairing",
		);

		const unknown: PullResult[] = [
			{ ok: false, docId: "a", notePath: "Nota.md", error: "iets onbekends" },
		];
		expect(renderImportReport({ ...base, results: unknown })).toContain(
			"connection or your pairing",
		);
	});

	it("confirms success and mentions the forced mode", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 4,
				scan: scan({ highlightFiles: 2, parsedHighlights: 4 }),
			},
		];
		const report = renderImportReport({ ...base, forced: true, results });
		expect(report).toContain("forced re-import");
		expect(report).toContain("Imported successfully");
		expect(report).toContain("4 highlight(s)");
	});
});
