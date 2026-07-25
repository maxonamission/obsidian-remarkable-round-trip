/**
 * Pull orchestration for the incoming route (PRD F10/F11; design:
 * docs/ontwerp-inkomende-route.md).
 *
 * Walks the known mappings, skips documents whose device hash has not
 * changed since the last import, downloads the highlight files of the rest,
 * and hands the result to the vault writer. Pure over injected adapters, so
 * the whole flow is testable without a device.
 */

import { MappingEntry, MappingTable } from "../id/mapping";
import {
	Highlight,
	isHighlightFile,
	pageIdFromHighlightPath,
	parseHighlightPage,
} from "./highlights";

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
	/** Pages rendered from handwriting (F12). */
	renderedPages: number;
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
	 * Render one page's strokes to an image and return the vault path of the
	 * embed. Absent means handwriting import is switched off.
	 */
	renderStrokes?: (
		deviceDocId: string,
		pageIndex: number,
		bytes: Uint8Array,
	) => Promise<string | null>;
	/** Diagnostic sink; the plugin edge collects these for the user. */
	log?: (line: string) => void;
	/**
	 * Page order for a document (page ids as listed in `.content`), used to
	 * number highlights. Optional: without it, highlights stay unnumbered.
	 */
	readPageOrder?: (deviceDocId: string, hash: string) => Promise<string[]>;
	/** Persist the rendered annotations for one source note. */
	writeAnnotations: (
		entry: MappingEntry,
		highlights: Highlight[],
		images: string[],
	) => Promise<void>;
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
	deviceDocId: string,
	hash: string,
	deps: PullDeps,
): Promise<{ highlights: Highlight[]; scan: DocumentScan; images: string[] }> {
	const allFiles = await deps.listDocumentFiles(deviceDocId, hash);
	const files = allFiles.filter((file) => isHighlightFile(file.id));
	const strokeFiles = allFiles.filter((file) => file.id.endsWith(".rm"));
	const scan: DocumentScan = {
		totalFiles: allFiles.length,
		highlightFiles: files.length,
		strokeFiles: strokeFiles.length,
		parsedHighlights: 0,
		unreadableFiles: 0,
		renderedPages: 0,
	};
	const images = await renderStrokePages(deviceDocId, strokeFiles, deps, scan);
	deps.log?.(
		`  files: ${scan.totalFiles} total, ${scan.highlightFiles} highlight, ${scan.strokeFiles} stroke (.rm)`,
	);
	if (files.length === 0) return { highlights: [], scan, images };

	const order = deps.readPageOrder ? await deps.readPageOrder(deviceDocId, hash) : [];
	const pageNumber = new Map(order.map((pageId, index) => [pageId, index + 1]));

	const perFile: { page: number; highlights: Highlight[] }[] = [];
	for (const file of files) {
		const pageId = pageIdFromHighlightPath(file.id);
		// Unknown pages sort last but keep a stable order among themselves.
		const page = (pageId !== null ? pageNumber.get(pageId) : undefined) ?? Number.MAX_SAFE_INTEGER;
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
	const highlights = perFile.flatMap((entry) => entry.highlights);
	scan.parsedHighlights = highlights.length;
	return { highlights, scan, images };
}

/** Render each handwritten page to an image; failures cost that page only. */
async function renderStrokePages(
	deviceDocId: string,
	strokeFiles: DocumentFile[],
	deps: PullDeps,
	scan: DocumentScan,
): Promise<string[]> {
	if (!deps.renderStrokes || !deps.readBytes || strokeFiles.length === 0) return [];
	const images: string[] = [];
	// Page order inside a document is not encoded in the file names, so keep
	// the order the index gave us — it matches the document's own order.
	for (const [index, file] of strokeFiles.entries()) {
		try {
			const bytes = await deps.readBytes(file);
			const path = await deps.renderStrokes(deviceDocId, index + 1, bytes);
			if (path !== null) {
				images.push(path);
				scan.renderedPages++;
			}
		} catch (error) {
			scan.unreadableFiles++;
			deps.log?.(
				`  could not render ${file.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	deps.log?.(`  rendered ${images.length} handwritten page(s)`);
	return images;
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
				const { highlights, scan, images } = await collectHighlights(
					entry.deviceDocId,
					hash,
					deps,
				);
				await deps.writeAnnotations(entry, highlights, images);
				updated = { ...updated, [entry.docId]: { ...entry, importedHash: hash } };
				result = {
					ok: true,
					docId: entry.docId,
					notePath: entry.notePath,
					highlightCount: highlights.length,
					scan,
				};
			}
		} catch (error) {
			deps.log?.(
				`  failed: ${error instanceof Error ? error.message : String(error)}`,
			);
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
