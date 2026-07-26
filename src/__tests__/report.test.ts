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
		expect(renderImportReport({ ...base, results })).toContain("3 highlight(s) (from the pen layer)");
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
