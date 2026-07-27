/**
 * Turning an import run into an explanation (GP_E3_S6).
 *
 * "Nothing was imported" has several very different causes, and on mobile
 * there is no console to inspect. This renders the run into a report the
 * user can read — and paste — so the next question is answerable.
 */

import { adviseFailure, classifyFailure } from "../transport/failure";
import { PullResult } from "./pull";

export interface ImportReportInput {
	results: PullResult[];
	forced: boolean;
	startedAt: string;
	pluginVersion: string;
	/** Whether handwriting rendering was on for this run (F12 setting). */
	handwritingEnabled?: boolean;
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
		const read = scan.interpretedMarks > 0 ? `, ${scan.interpretedMarks} read as text` : "";
		const anchored =
			scan.renderedRemarks > 0 ? `, ${scan.anchoredRemarks} tied to the source` : "";
		const rendered =
			scan.renderedPages > 0
				? `, ${scan.renderedRemarks} pen mark(s) on ${scan.renderedPages} page(s)${read}${anchored}`
				: "";
		const source =
			scan.highlightsInStrokes > 0 && scan.highlightFiles === 0 ? " (from the pen layer)" : "";
		lines.push(
			`✓ ${result.notePath}: ${result.highlightCount} highlight(s)${source}${rendered} ` +
				`(${scan.totalFiles} files, ${scan.highlightFiles} highlight, ${scan.strokeFiles} stroke)`,
		);
		if (scan.unreadableFiles > 0) {
			lines.push(`    ${scan.unreadableFiles} file(s) could not be read`);
		}
		lines.push(`    ${describeWrite(scan)}`);
	}

	lines.push("", diagnose(input));
	return lines.join("\n");
}

/**
 * What ended up in the vault. Until now the report only described the
 * *reading* side, so a failed projection looked like a successful import that
 * did nothing (beta, 2026-07-27).
 */
function describeWrite(scan: NonNullable<Extract<PullResult, { ok: true }>["scan"]>): string {
	const written = scan.written;
	if (written === undefined) return "written as: (not recorded)";
	if (written.form === "copy") {
		const missed =
			written.unplaced === undefined || written.unplaced === 0
				? ""
				: `, ${written.unplaced} highlight(s) listed separately`;
		return `written as: annotated copy of the note${missed}`;
	}
	switch (written.reason) {
		case "in-source-note":
			return "written as: summary (annotations go into the source note itself)";
		case "no-layout":
			return (
				"written as: summary — the note changed since it was sent, or it went " +
				"over as EPUB. Send it again for an annotated copy."
			);
		case "no-source":
			return "written as: summary — the source note could not be read";
		default:
			return (
				"written as: summary — the marks could not be lined up with the note. " +
				"Worth reporting with this report attached."
			);
	}
}

/** The most useful next sentence, given what the run found. */
function diagnose(input: ImportReportInput): string {
	const results = input.results;
	const successes = results.filter((r): r is Extract<PullResult, { ok: true }> => r.ok);
	const scanned = successes.filter((r) => r.scan !== undefined);
	const imported = successes.filter((r) => r.highlightCount > 0);
	const failures = results.filter((r) => !r.ok);
	const renderedPages = successes.reduce((total, r) => total + (r.scan?.renderedPages ?? 0), 0);
	const anchored = successes.reduce((total, r) => total + (r.scan?.anchoredRemarks ?? 0), 0);
	const unanchored = scanned.some((r) => r.scan?.anchorSkipped === "no-layout");
	const anchoring =
		anchored > 0
			? ` ${anchored} are tied to the sentence they were written against.`
			: unanchored
				? " They could not be quoted against the source text: the note has changed since it " +
					"was sent, or it went over as EPUB, which has no fixed page layout. Send the note " +
					"again to restore the link."
				: "";
	const interpreted = successes.reduce(
		(total, r) => total + (r.scan?.interpretedMarks ?? 0),
		0,
	);
	const reading =
		interpreted > 0
			? ` ${interpreted} of them were read as text — struck through, circled, underlined or ` +
				"marked in the margin — and name the words they point at."
			: "";
	const handwriting =
		renderedPages > 0
			? ` ${renderedPages} page(s) with pen marks came back.${reading}${anchoring}`
			: "";

	if (imported.length > 0) {
		return (
			"Imported successfully. Re-running skips documents you have not touched since." +
			handwriting
		);
	}
	if (renderedPages > 0) {
		return (
			`No text highlights were found, but ${renderedPages} page(s) with pen marks came ` +
			`back.${reading} The reMarkable only writes a highlight file when you select text ` +
			"and highlight it on a text layer; freehand marks and handwriting are pen strokes, " +
			`which this plugin reads separately.${anchoring}`
		);
	}
	if (failures.length === results.length && failures.length > 0) {
		const kind = classifyFailure(failures[0].ok ? "" : failures[0].error);
		const advice = adviseFailure(kind);
		return advice === ""
			? "Every document failed — that points at the connection or your pairing rather than at the documents."
			: `Every document failed, so the cause is not in the documents. ${advice}`;
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
		const why =
			input.handwritingEnabled === false
				? "Importing handwriting is switched off — turn on 'Import handwriting' in the " +
					"settings to get those pages back as images."
				: "Those strokes could not be rendered: the pages hold no ink this version " +
					"recognises, or reading them failed (see the details below).";
		return (
			"The documents contain pen strokes but no text highlights. The reMarkable " +
			"only writes a highlight file when you select text and highlight it " +
			"(the 'smart' highlighter on a text layer); freehand marks and handwriting " +
			`are strokes. ${why}`
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
