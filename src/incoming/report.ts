/**
 * Turning an import run into an explanation (GP_E3_S6).
 *
 * "Nothing was imported" has several very different causes, and on mobile
 * there is no console to inspect. This renders the run into a report the
 * user can read — and paste — so the next question is answerable.
 */

import { PullResult } from "./pull";

export interface ImportReportInput {
	results: PullResult[];
	forced: boolean;
	startedAt: string;
	pluginVersion: string;
}

export function renderImportReport(input: ImportReportInput): string {
	const lines = [
		`reMarkable Round-Trip — import report (${input.startedAt})`,
		`plugin ${input.pluginVersion}${input.forced ? " · forced re-import" : ""}`,
		"",
	];

	if (input.results.length === 0) {
		lines.push("No notes have been sent yet, so there is nothing to import.");
		return lines.join("\n");
	}

	for (const result of input.results) {
		if (!result.ok) {
			lines.push(`✗ ${result.notePath}: ${result.error}`);
			continue;
		}
		if (result.skipped) {
			lines.push(
				result.skipReason === "not-on-device"
					? `– ${result.notePath}: no longer on the reMarkable account`
					: `– ${result.notePath}: unchanged since the last import`,
			);
			continue;
		}
		const scan = result.scan;
		if (scan === undefined) {
			lines.push(`✓ ${result.notePath}: ${result.highlightCount} highlight(s)`);
			continue;
		}
		lines.push(
			`✓ ${result.notePath}: ${result.highlightCount} highlight(s) ` +
				`(${scan.totalFiles} files, ${scan.highlightFiles} highlight, ${scan.strokeFiles} stroke)`,
		);
		if (scan.unreadableFiles > 0) {
			lines.push(`    ${scan.unreadableFiles} file(s) could not be read`);
		}
	}

	lines.push("", diagnose(input.results));
	return lines.join("\n");
}

/** The most useful next sentence, given what the run found. */
function diagnose(results: PullResult[]): string {
	const successes = results.filter((r): r is Extract<PullResult, { ok: true }> => r.ok);
	const scanned = successes.filter((r) => r.scan !== undefined);
	const imported = successes.filter((r) => r.highlightCount > 0);
	const failures = results.filter((r) => !r.ok);

	if (imported.length > 0) {
		return "Imported successfully. Re-running skips documents you have not touched since.";
	}
	if (failures.length === results.length && failures.length > 0) {
		return "Every document failed — that points at the connection or your pairing rather than at the documents.";
	}
	if (scanned.length === 0) {
		return (
			"Nothing was examined: every mapped note was skipped. Use " +
			"'Re-import all annotations' to look again regardless, or send the note " +
			"anew if it is no longer on the account."
		);
	}
	const withStrokes = scanned.filter((r) => (r.scan?.strokeFiles ?? 0) > 0);
	const withHighlightFiles = scanned.filter((r) => (r.scan?.highlightFiles ?? 0) > 0);

	if (withHighlightFiles.length === 0 && withStrokes.length > 0) {
		return (
			"The documents contain pen strokes but no text highlights. The reMarkable " +
			"only writes a highlight file when you select text and highlight it " +
			"(the 'smart' highlighter on a text layer); freehand marks and handwriting " +
			"are strokes, and importing those is not built yet."
		);
	}
	if (withHighlightFiles.length === 0) {
		return (
			"The documents hold neither highlight files nor strokes — the annotations " +
			"may not have reached the cloud yet. Let the tablet finish syncing and try again."
		);
	}
	return (
		"Highlight files were found but yielded no text. That suggests a firmware " +
		"format this version does not recognise yet — worth reporting with this report attached."
	);
}
