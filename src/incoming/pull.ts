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
import { clusterStrokes, quoteForInk } from "./anchor";
import { Highlight, isHighlightFile, parseHighlightPage } from "./highlights";
import { PageMap, parsePageOrder } from "./pagemap";
import { parseRmLines } from "./rmlines";

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
	/** Pages that yielded at least one handwriting image (F12). */
	renderedPages: number;
	/** Individual remarks rendered; a page can hold several (GP_E3_S8). */
	renderedRemarks: number;
	/** Remarks that could be quoted against the source text (GP_E3_S8). */
	anchoredRemarks: number;
	/** Why anchoring was unavailable, when it was. */
	anchorSkipped?: "no-layout";
}

/** One rendered remark, ready to be written into the vault. */
export interface HandwritingImage {
	/** Vault path of the rendered image. */
	path: string;
	/** Page in the source document, when it could be determined. */
	page?: number;
	/** The text this ink sits against (GP_E3_S8). */
	quote?: string;
}

/** What the edge needs to paint one remark. */
export interface StrokeRenderRequest {
	deviceDocId: string;
	strokes: import("./rmlines").Stroke[];
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
	/** Persist the rendered annotations for one source note. */
	writeAnnotations: (
		entry: MappingEntry,
		highlights: Highlight[],
		images: HandwritingImage[],
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
	entry: MappingEntry,
	hash: string,
	deps: PullDeps,
): Promise<{ highlights: Highlight[]; scan: DocumentScan; images: HandwritingImage[] }> {
	const deviceDocId = entry.deviceDocId;
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
		renderedRemarks: 0,
		anchoredRemarks: 0,
	};
	const pages = await readPageMap(deviceDocId, allFiles, deps, scan);
	const images = await renderStrokePages(entry, strokeFiles, pages, deps, scan);
	deps.log?.(
		`  files: ${scan.totalFiles} total, ${scan.highlightFiles} highlight, ${scan.strokeFiles} stroke (.rm)`,
	);
	if (files.length === 0) return { highlights: [], scan, images };

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
	const highlights = perFile.flatMap((entry) => entry.highlights);
	scan.parsedHighlights = highlights.length;
	return { highlights, scan, images };
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

/**
 * Render each handwritten remark to an image, quoted against the text it sits
 * on where possible. Failures cost that page only (N3).
 */
async function renderStrokePages(
	entry: MappingEntry,
	strokeFiles: DocumentFile[],
	pages: PageMap,
	deps: PullDeps,
	scan: DocumentScan,
): Promise<HandwritingImage[]> {
	if (!deps.renderStrokes || !deps.readBytes || strokeFiles.length === 0) return [];

	let layout: PdfLayout | null = null;
	try {
		layout = deps.loadLayout ? await deps.loadLayout(entry) : null;
	} catch (error) {
		deps.log?.(
			`  no anchoring: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (layout === null) scan.anchorSkipped = "no-layout";

	const images: HandwritingImage[] = [];
	for (const [index, file] of strokeFiles.entries()) {
		// Falling back to the file's ordinal keeps a number on the image when
		// `.content` was unreadable — flagged as such, never presented as the
		// document page.
		const page = pages.forFile(file.id);
		try {
			const bytes = await deps.readBytes(file);
			const clusters = clusterStrokes(parseRmLines(bytes));
			let renderedHere = 0;
			for (const [remark, cluster] of clusters.entries()) {
				const path = await deps.renderStrokes({
					deviceDocId: entry.deviceDocId,
					strokes: cluster.strokes,
					page: page ?? index + 1,
					remark: remark + 1,
				});
				if (path === null) continue;
				const quote =
					layout !== null && page !== undefined
						? quoteForInk(cluster.bounds, page, layout)
						: undefined;
				if (quote !== undefined) scan.anchoredRemarks++;
				images.push({ path, page, quote });
				renderedHere++;
			}
			if (renderedHere > 0) {
				scan.renderedPages++;
				scan.renderedRemarks += renderedHere;
			}
			deps.log?.(
				`  ${file.id}: page ${page ?? "?"}, ${clusters.length} remark(s), ${renderedHere} rendered`,
			);
		} catch (error) {
			scan.unreadableFiles++;
			deps.log?.(
				`  could not render ${file.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	deps.log?.(
		`  rendered ${scan.renderedRemarks} remark(s) on ${scan.renderedPages} page(s), ` +
			`${scan.anchoredRemarks} anchored to text`,
	);
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
				const { highlights, scan, images } = await collectHighlights(entry, hash, deps);
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
