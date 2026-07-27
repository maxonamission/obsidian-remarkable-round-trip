/**
 * Pull orchestration for the incoming route (PRD F10/F11; design:
 * docs/ontwerp-inkomende-route.md).
 *
 * Walks the known mappings, skips documents whose device hash has not
 * changed since the last import, downloads the highlight files of the rest,
 * and hands the result to the vault writer. Pure over injected adapters, so
 * the whole flow is testable without a device.
 */

import { PdfLayout } from "../convert/pdf";
import { MappingEntry, MappingTable } from "../id/mapping";
import type { AnnotationOutcome } from "./annotationnote";
import { Highlight, isHighlightFile, parseHighlightPage } from "./highlights";
import { MarkKind, readMarks } from "./marks";
import { PageMap, parsePageOrder } from "./pagemap";
import { Stroke, parseRmPage } from "./rmlines";

/** One file belonging to a device document. */
export interface DocumentFile {
	/** Path within the document, e.g. "<doc>.highlights/<page>.json". */
	id: string;
	hash: string;
}

/** What a document turned out to contain — the basis for diagnostics. */
export interface DocumentScan {
	totalFiles: number;
	/** `.highlights/*.json` files: selected *text*. */
	highlightFiles: number;
	/** `.rm` files: pen strokes, including the freehand highlighter. */
	strokeFiles: number;
	parsedHighlights: number;
	/** Files we could not read; they were skipped, not fatal. */
	unreadableFiles: number;
	/** Pages that yielded at least one annotation (F12). */
	renderedPages: number;
	/** Individual remarks found; a page can hold several (GP_E3_S8). */
	renderedRemarks: number;
	/** Remarks that could be tied to the source text (GP_E3_S8). */
	anchoredRemarks: number;
	/** Marks read as strike-through, circle, margin bar or arrow (GP_E3_S9). */
	interpretedMarks: number;
	/** Text highlights found inside the `.rm` pen layer (GP_E3_S11). */
	highlightsInStrokes: number;
	/** Why anchoring was unavailable, when it was. */
	anchorSkipped?: "no-layout";
	/** How the vault block came out: annotated copy or summary (GP_E3_S14). */
	written?: WriteOutcome;
	/** How the note relates to what was sent (F14, GP_E3_S3). */
	sourceState?: SourceState;
}

/** What the vault writer made of one document's annotations (GP_E3_S14). */
export type WriteOutcome = AnnotationOutcome;

/**
 * How the note in the vault relates to the document that was sent (F14,
 * GP_E3_S3).
 *
 * - `match` — unchanged; annotations land where they belong.
 * - `changed` — edited since it was sent, so the page geometry no longer
 *   describes this text. Annotations still come back, but unanchored.
 * - `moved` — found again elsewhere in the vault by its document id.
 * - `missing` — no note in the vault carries this document id any more.
 * - `no-snapshot` — sent before the plugin recorded typography (or as EPUB).
 */
export type SourceState = "match" | "changed" | "moved" | "missing" | "no-snapshot";

/** One annotation as it will appear in the vault (GP_E3_S9). */
export interface ImportedMark {
	kind: MarkKind;
	/** Page in the source document, when it could be determined. */
	page?: number;
	/** The words the mark points at. */
	target?: string;
	/** Ids of the covered words, for the annotated copy (GP_E3_S12). */
	words?: number[];
	/** Source blocks a margin bar spans. */
	blocks?: number[];
	/** The line the mark sits against, for context. */
	quote?: string;
	/** Vault path of the rendered ink; only kinds that need a picture have one. */
	path?: string;
}

/** What the edge needs to paint one remark. */
export interface StrokeRenderRequest {
	deviceDocId: string;
	strokes: Stroke[];
	/** Page number when known, else the ordinal of the stroke file. */
	page: number;
	/** 1-based index of this remark within its page. */
	remark: number;
}

export interface PullDeps {
	/** Current device documents, by cloud document id → content hash. */
	listDocumentHashes: () => Promise<Map<string, string>>;
	/** Files belonging to a device document at the given hash. */
	listDocumentFiles: (deviceDocId: string, hash: string) => Promise<DocumentFile[]>;
	/** Text contents of one document file. */
	readFile: (file: DocumentFile) => Promise<string>;
	/** Raw bytes of one document file (for `.rm` stroke pages). */
	readBytes?: (file: DocumentFile) => Promise<Uint8Array>;
	/**
	 * Paint one remark and return the vault path of the embed. Absent means
	 * handwriting import is switched off.
	 */
	renderStrokes?: (request: StrokeRenderRequest) => Promise<string | null>;
	/** Diagnostic sink; the plugin edge collects these for the user. */
	log?: (line: string) => void;
	/**
	 * Reproduce the page layout of the document as it was sent, so ink can be
	 * quoted against the text it sits on (GP_E3_S8). Returning null — no
	 * snapshot, EPUB, or a source note that changed since — costs the quotes
	 * and nothing else.
	 */
	loadLayout?: (entry: MappingEntry) => Promise<PdfLayout | null>;
	/**
	 * Whether the note still matches the document that was sent (F14). A
	 * changed note is not an error — the annotations are real — but the reader
	 * has to know that they describe an older version.
	 */
	checkSource?: (entry: MappingEntry) => Promise<SourceState>;
	/**
	 * Persist the rendered annotations for one source note. The outcome says
	 * whether it became an annotated copy or fell back to a summary — a silent
	 * fallback cost the owner two test rounds (GP_E3_S14).
	 */
	writeAnnotations: (
		entry: MappingEntry,
		highlights: Highlight[],
		marks: ImportedMark[],
		/** How the note relates to what was sent, so the block can say so (F14). */
		sourceState?: SourceState,
	) => Promise<WriteOutcome | void>;
	/** Re-import even when the device hash is unchanged. */
	force?: boolean;
}

export interface PullSuccess {
	ok: true;
	docId: string;
	notePath: string;
	highlightCount: number;
	/** True when nothing changed on the device and the note was left alone. */
	skipped?: boolean;
	/** Why it was skipped, for the diagnostic report. */
	skipReason?: "unchanged" | "not-on-device";
	scan?: DocumentScan;
}

export interface PullFailure {
	ok: false;
	docId: string;
	notePath: string;
	error: string;
}

export type PullResult = PullSuccess | PullFailure;

/**
 * Collect the highlights of one device document, ordered by page, together
 * with a scan of what the document actually held. The scan is what makes an
 * empty result explainable: no highlight files at all means the annotations
 * are pen strokes, not selected text (GP_E3_S6).
 */
export async function collectHighlights(
	entry: MappingEntry,
	hash: string,
	deps: PullDeps,
): Promise<{
	highlights: Highlight[];
	scan: DocumentScan;
	marks: ImportedMark[];
}> {
	const deviceDocId = entry.deviceDocId;
	const allFiles = await deps.listDocumentFiles(deviceDocId, hash);
	const files = allFiles.filter((file) => isHighlightFile(file.id));
	const strokeFiles = allFiles.filter((file) => file.id.endsWith(".rm"));
	// Names, not just counts: the beta showed highlights on the device that
	// never arrived, and only the actual file list can settle why (GP_E3_S9).
	deps.log?.(`  files: ${allFiles.map((file) => file.id).join(", ")}`);
	const scan: DocumentScan = {
		totalFiles: allFiles.length,
		highlightFiles: files.length,
		strokeFiles: strokeFiles.length,
		parsedHighlights: 0,
		unreadableFiles: 0,
		renderedPages: 0,
		renderedRemarks: 0,
		anchoredRemarks: 0,
		interpretedMarks: 0,
		highlightsInStrokes: 0,
	};
	if (deps.checkSource) {
		// Diagnosis, not a precondition: if the vault cannot answer, the
		// annotations still come back — one unreadable note must not cost them.
		scan.sourceState = await deps.checkSource(entry).catch((error: unknown) => {
			deps.log?.(`  source check failed: ${String(error)}`);
			return undefined;
		});
		if (scan.sourceState !== undefined && scan.sourceState !== "match") {
			deps.log?.(`  source note: ${scan.sourceState}`);
		}
	}
	const pages = await readPageMap(deviceDocId, allFiles, deps, scan);
	const { marks, highlights: inkHighlights } = await readStrokePages(
		entry,
		strokeFiles,
		pages,
		deps,
		scan,
	);
	deps.log?.(
		`  totals: ${scan.totalFiles} files, ${scan.highlightFiles} highlight, ${scan.strokeFiles} stroke (.rm)`,
	);
	if (files.length === 0) {
		scan.parsedHighlights = inkHighlights.length;
		return { highlights: inkHighlights, scan, marks };
	}

	const perFile: { page: number; highlights: Highlight[] }[] = [];
	for (const file of files) {
		// Unknown pages sort last but keep a stable order among themselves.
		const page = pages.forFile(file.id) ?? Number.MAX_SAFE_INTEGER;
		let text: string;
		try {
			text = await deps.readFile(file);
		} catch (error) {
			scan.unreadableFiles++;
			deps.log?.(
				`  could not read ${file.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue; // one unreadable page must not sink the document (N3)
		}
		const highlights = parseHighlightPage(
			text,
			page === Number.MAX_SAFE_INTEGER ? undefined : page,
		);
		deps.log?.(
			`  ${file.id}: ${highlights.length} highlight(s) parsed from ${text.length} bytes`,
		);
		if (highlights.length > 0) perFile.push({ page, highlights });
	}

	perFile.sort((a, b) => a.page - b.page);
	// Both sources carry a page number, so merge and order by page.
	const highlights = [...inkHighlights, ...perFile.flatMap((item) => item.highlights)].sort(
		(a, b) => (a.page ?? Number.MAX_SAFE_INTEGER) - (b.page ?? Number.MAX_SAFE_INTEGER),
	);
	scan.parsedHighlights = highlights.length;
	return { highlights, scan, marks };
}

/** Page order from the document's `.content`; empty map when unavailable. */
async function readPageMap(
	deviceDocId: string,
	allFiles: DocumentFile[],
	deps: PullDeps,
	scan: DocumentScan,
): Promise<PageMap> {
	const content = allFiles.find((file) => file.id === `${deviceDocId}.content`);
	if (content === undefined) return new PageMap([]);
	try {
		const order = parsePageOrder(await deps.readFile(content));
		deps.log?.(`  page order: ${order.length} page(s) listed in .content`);
		return new PageMap(order);
	} catch (error) {
		scan.unreadableFiles++;
		deps.log?.(
			`  could not read the page order: ${error instanceof Error ? error.message : String(error)}`,
		);
		return new PageMap([]);
	}
}

/** Kinds the text says everything about; a picture of the ink adds nothing. */
const TEXT_ONLY_KINDS = new Set<MarkKind>(["strikethrough", "underline", "circle", "margin"]);

/**
 * Read every annotated page: marks come back as typed text, handwriting as an
 * image with the line it sits against. Failures cost that page only (N3).
 */
async function readStrokePages(
	entry: MappingEntry,
	strokeFiles: DocumentFile[],
	pages: PageMap,
	deps: PullDeps,
	scan: DocumentScan,
): Promise<{ marks: ImportedMark[]; highlights: Highlight[] }> {
	const empty = { marks: [], highlights: [] };
	// Only the byte reader is essential: the pen layer also carries the text
	// highlights, so it must be read even when handwriting import is off.
	if (!deps.readBytes || strokeFiles.length === 0) return empty;

	let layout: PdfLayout | null = null;
	try {
		layout = deps.loadLayout ? await deps.loadLayout(entry) : null;
	} catch (error) {
		deps.log?.(`  no anchoring: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (layout === null) scan.anchorSkipped = "no-layout";

	const collected: {
		page: number | undefined;
		order: number;
		mark: ImportedMark;
	}[] = [];
	const highlights: Highlight[] = [];
	for (const [index, file] of strokeFiles.entries()) {
		// Falling back to the file's ordinal keeps a number on the image when
		// `.content` was unreadable — flagged as such, never presented as the
		// document page.
		const page = pages.forFile(file.id);
		try {
			const bytes = await deps.readBytes(file);
			const rm = parseRmPage(bytes);
			// The "smart" highlighter writes its text into the same page file
			// as the strokes on this firmware (GP_E3_S11).
			for (const found of rm.highlights) {
				highlights.push({ text: found.text, color: found.color, page });
				scan.highlightsInStrokes++;
			}
			if (rm.highlights.length > 0) {
				// Raw colour values: the mapping to names is a guess until a
				// real device confirms it (GP_E3_S12).
				for (const found of rm.highlights) {
					deps.log?.(
						`    highlight fields ${Object.entries(found.fields ?? {})
							.map(([tag, value]) => `${tag}=${value}`)
							.join(",")} tail ${found.tail ?? ""}`,
					);
				}
			}
			const marks = readMarks(rm.strokes, page ?? 0, page === undefined ? null : layout);
			let onThisPage = 0;
			for (const [position, mark] of marks.entries()) {
				const needsImage = !TEXT_ONLY_KINDS.has(mark.kind);
				let path: string | undefined;
				if (needsImage && deps.renderStrokes === undefined) {
					continue; // handwriting import is off; nothing to show
				}
				if (needsImage && deps.renderStrokes !== undefined) {
					const rendered = await deps.renderStrokes({
						deviceDocId: entry.deviceDocId,
						strokes: mark.strokes,
						page: page ?? index + 1,
						remark: position + 1,
					});
					// Ink that renders to nothing is not worth a line in the note.
					if (rendered === null) continue;
					path = rendered;
				} else {
					scan.interpretedMarks++;
				}
				if (mark.target !== undefined || mark.quote !== undefined) scan.anchoredRemarks++;
				collected.push({
					page,
					order: position,
					mark: {
						kind: mark.kind,
						page,
						target: mark.target,
						words: mark.words,
						blocks: mark.blocks,
						quote: mark.quote,
						path,
					},
				});
				onThisPage++;
			}
			if (onThisPage > 0) {
				scan.renderedPages++;
				scan.renderedRemarks += onThisPage;
			}
			deps.log?.(
				`  ${file.id}: page ${page ?? "?"}, ${marks.length} mark(s) — ` +
					`${marks.map((mark) => mark.kind).join(", ")}; ` +
					`${rm.highlights.length} highlight(s); ` +
					`blocks ${Object.entries(rm.blockTypes)
						.map(([type, count]) => `0x0${type}×${count}`)
						.join(" ")}`,
			);
		} catch (error) {
			scan.unreadableFiles++;
			deps.log?.(
				`  could not read ${file.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// Document order, not the order the cloud happened to list the files in —
	// the beta returned pages 2, 4, 3, 1 (GP_E3_S9). Highlights need the same
	// treatment: they came out in stroke-file order (GP_E3_S12).
	collected.sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity) || a.order - b.order);
	highlights.sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity));
	deps.log?.(
		`  ${scan.renderedRemarks} mark(s) on ${scan.renderedPages} page(s), ` +
			`${scan.interpretedMarks} read as text, ${scan.anchoredRemarks} tied to the source, ` +
			`${scan.highlightsInStrokes} highlight(s) from the pen layer`,
	);
	return { marks: collected.map((item) => item.mark), highlights };
}

/**
 * Import annotations for every known mapping. Never throws: each document
 * comes back as its own result (same discipline as the outgoing batch).
 */
export async function pullAnnotations(
	table: MappingTable,
	deps: PullDeps,
	onProgress?: (done: number, total: number, current: PullResult) => void,
): Promise<{ results: PullResult[]; table: MappingTable }> {
	const entries = Object.values(table);
	const results: PullResult[] = [];
	let updated = table;

	let hashes: Map<string, string>;
	try {
		hashes = await deps.listDocumentHashes();
	} catch (error) {
		// Cannot reach the device at all: report once per mapping rather than
		// pretending some succeeded.
		const message = error instanceof Error ? error.message : String(error);
		return {
			results: entries.map((entry) => ({
				ok: false as const,
				docId: entry.docId,
				notePath: entry.notePath,
				error: message,
			})),
			table,
		};
	}

	deps.log?.(`${entries.length} mapped note(s); ${hashes.size} document(s) on the account`);

	for (const entry of entries) {
		const hash = hashes.get(entry.deviceDocId);
		let result: PullResult;
		try {
			deps.log?.(`${entry.notePath} → device ${entry.deviceDocId}`);
			if (hash === undefined) {
				// The document is gone from the device (deleted or moved out of
				// reach): not an error, just nothing to import.
				deps.log?.("  not on the account — skipped");
				result = {
					ok: true,
					docId: entry.docId,
					notePath: entry.notePath,
					highlightCount: 0,
					skipped: true,
					skipReason: "not-on-device",
				};
			} else if (!deps.force && entry.importedHash === hash) {
				deps.log?.(`  unchanged since last import (${hash.slice(0, 8)}…) — skipped`);
				result = {
					ok: true,
					docId: entry.docId,
					notePath: entry.notePath,
					highlightCount: 0,
					skipped: true,
					skipReason: "unchanged",
				};
			} else {
				const { highlights, scan, marks } = await collectHighlights(entry, hash, deps);
				const written = await deps.writeAnnotations(entry, highlights, marks, scan.sourceState);
				if (written) scan.written = written;
				updated = {
					...updated,
					[entry.docId]: { ...entry, importedHash: hash },
				};
				result = {
					ok: true,
					docId: entry.docId,
					notePath: entry.notePath,
					highlightCount: highlights.length,
					scan,
				};
			}
		} catch (error) {
			deps.log?.(`  failed: ${error instanceof Error ? error.message : String(error)}`);
			result = {
				ok: false,
				docId: entry.docId,
				notePath: entry.notePath,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		results.push(result);
		onProgress?.(results.length, entries.length, result);
	}

	return { results, table: updated };
}
