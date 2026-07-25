import { describe, expect, it } from "vitest";
import { PullResult } from "../incoming/pull";
import { renderImportReport } from "../incoming/report";

const base = { forced: false, startedAt: "2026-07-25 22:30", pluginVersion: "0.6.0" };

const scan = (over: Partial<NonNullable<Extract<PullResult, { ok: true }>["scan"]>> = {}) => ({
	totalFiles: 5,
	highlightFiles: 0,
	strokeFiles: 0,
	parsedHighlights: 0,
	unreadableFiles: 0,
	...over,
});

describe("renderImportReport", () => {
	it("says plainly when nothing has been sent yet", () => {
		expect(renderImportReport({ ...base, results: [] })).toContain("nothing to import");
	});

	it("names the most likely cause when a document only holds pen strokes", () => {
		const results: PullResult[] = [
			{
				ok: true,
				docId: "a",
				notePath: "Nota.md",
				highlightCount: 0,
				scan: scan({ strokeFiles: 3 }),
			},
		];
		const report = renderImportReport({ ...base, results });
		expect(report).toContain("pen strokes but no text highlights");
		expect(report).toContain("not built yet");
		expect(report).toContain("5 files, 0 highlight, 3 stroke");
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

	it("blames the connection when every document failed", () => {
		const results: PullResult[] = [
			{ ok: false, docId: "a", notePath: "Nota.md", error: "401" },
		];
		expect(renderImportReport({ ...base, results })).toContain("connection or your pairing");
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
