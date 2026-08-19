/**
 * Upload and read typed-text notebooks through the raw sync API
 * (PRD F16/F17, GP_E7_S2 — promoted from spike GP_E7_S1).
 *
 * The bundle mirrors what rmapi-js' own putPdf uploads — content, metadata,
 * pagedata, the payload file, one entries list, root update — with two
 * notebook-specific differences: the payload is a `{docId}/{pageId}.rm` page
 * (not `{docId}.pdf`) and the content JSON says `fileType: "notebook"` with
 * the page listed in `pages`. Every field written here is one modern firmware
 * writes itself: rmapi-js validates content JSON strictly when *listing* the
 * account, and one stray field broke folder mirroring for every send until
 * the offending document was deleted (spike-bevinding 2026-08-19).
 *
 * Root updates race with the tablet's own sync; `sendTextNotebook` retries
 * generation conflicts with the same policy as folder mirroring, reusing one
 * docId across attempts so a retry updates rather than duplicates (N3).
 */

import { buildTextPageRm, readTextPageRm } from "../convert/rmtext";
import { markdownFromParagraphs, paragraphsFromMarkdown } from "../convert/textdoc";
import { withGenerationRetry, type RetryOptions } from "./mirror";
import type { UploadResult } from "./cloud";

/** The slice of rmapi-js' raw api this module consumes (structural, testable). */
export interface RawSyncApi {
	getRootHash(): Promise<[string, number, number]>;
	getEntries(id: string, hash: string): Promise<{ entries: RawEntry[] }>;
	getHash(id: string, hash: string): Promise<Uint8Array>;
	putFile(id: string, bytes: Uint8Array): Promise<[RawEntry, Promise<void>]>;
	putText(id: string, content: string): Promise<[RawEntry, Promise<void>]>;
	putEntries(
		id: string,
		entries: readonly RawEntry[],
		schemaVersion: number,
	): Promise<[RawEntry, Promise<void>]>;
	putRootHash(hash: string, generation: number): Promise<[string, number]>;
}

export interface RawEntry {
	id: string;
	hash: string;
}

export interface TextUploadResult {
	docId: string;
	pageId: string;
}

/** RFC4122-v4-shaped id from crypto randomness (same approach as docid.ts). */
function uuid4(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface TextUploadOptions {
	/** Device collection to file the notebook under ("" or absent = root). */
	parentId?: string;
	/** Fixed ids so a caller's retry updates instead of duplicating. */
	docId?: string;
	pageId?: string;
	now?: () => number;
}

/**
 * Upload `markdown` as an editable typed-text notebook. One attempt, no
 * retry — `sendTextNotebook` below is the production entry point.
 */
export async function uploadTextNotebook(
	api: RawSyncApi,
	visibleName: string,
	markdown: string,
	options: TextUploadOptions = {},
): Promise<TextUploadResult> {
	const docId = options.docId ?? uuid4();
	const pageId = options.pageId ?? uuid4();
	const now = options.now ?? Date.now;
	const rm = buildTextPageRm(paragraphsFromMarkdown(markdown));
	const timestamp = now().toFixed();

	const metadata = {
		parent: options.parentId ?? "",
		pinned: false,
		lastModified: timestamp,
		createdTime: timestamp,
		type: "DocumentType",
		visibleName,
		lastOpened: timestamp,
		lastOpenedPage: 0,
	};
	const content = {
		coverPageNumber: -1,
		documentMetadata: {},
		extraMetadata: {},
		fileType: "notebook",
		fontName: "",
		formatVersion: 1,
		lineHeight: -1,
		margins: 125,
		orientation: "portrait",
		originalPageCount: 0,
		pageCount: 1,
		pageTags: [],
		pages: [pageId],
		redirectionPageMap: [-1],
		sizeInBytes: rm.length.toFixed(),
		tags: [],
		textAlignment: "justify",
		textScale: 1,
		zoomMode: "bestFit",
	};

	const [[contentEntry, uploadContent], [metadataEntry, uploadMetadata], [pagedataEntry, uploadPagedata], [fileEntry, uploadFile], [rootHash, generation, schemaVersion]] =
		await Promise.all([
			api.putText(`${docId}.content`, JSON.stringify(content)),
			api.putText(`${docId}.metadata`, JSON.stringify(metadata)),
			api.putText(`${docId}.pagedata`, "\n"),
			api.putFile(`${docId}/${pageId}.rm`, rm),
			api.getRootHash(),
		]);

	const [[collectionEntry, uploadCollection], { entries: rootEntries }] = await Promise.all([
		api.putEntries(
			docId,
			[contentEntry, metadataEntry, pagedataEntry, fileEntry],
			schemaVersion,
		),
		api.getEntries("root.docSchema", rootHash),
	]);

	// A retry re-runs the whole attempt with the same docId: drop any entry a
	// previous attempt already placed, so the root never lists it twice.
	const [rootEntry, uploadRoot] = await api.putEntries(
		"root",
		[...rootEntries.filter((entry) => entry.id !== docId), collectionEntry],
		4,
	);
	await Promise.all([
		uploadContent,
		uploadMetadata,
		uploadPagedata,
		uploadFile,
		uploadCollection,
		uploadRoot,
	]);
	await api.putRootHash(rootEntry.hash, generation);

	return { docId, pageId };
}

/**
 * Production upload: one notebook, generation conflicts retried with the
 * same policy as folder mirroring. The ids are fixed before the first
 * attempt, so a retry after a half-landed attempt updates the same document
 * instead of creating a sibling (idempotent re-send, N3).
 */
export async function sendTextNotebook(
	api: RawSyncApi,
	visibleName: string,
	markdown: string,
	options: { parentId?: string; retry?: RetryOptions; now?: () => number } = {},
): Promise<UploadResult> {
	const docId = uuid4();
	const pageId = uuid4();
	const result = await withGenerationRetry(
		() =>
			uploadTextNotebook(api, visibleName, markdown, {
				parentId: options.parentId,
				docId,
				pageId,
				now: options.now,
			}),
		options.retry,
	);
	return { deviceDocId: result.docId };
}

export interface TextReadResult {
	markdown: string;
	paragraphCount: number;
	/** True when the page carried no root-text block (pure ink page). */
	missing: boolean;
}

/**
 * Read the (possibly edited) text of a notebook back. The import into the
 * source note — conflict guard, previous-version safety net — is GP_E7_S3;
 * this is the transport half it will build on.
 */
export async function readTextNotebook(
	api: RawSyncApi,
	docId: string,
): Promise<TextReadResult> {
	const [rootHash] = await api.getRootHash();
	const { entries: rootEntries } = await api.getEntries("root.docSchema", rootHash);
	const docEntry = rootEntries.find((entry) => entry.id === docId);
	if (!docEntry) throw new Error(`Notebook ${docId} not found in the account root.`);
	const { entries } = await api.getEntries(`${docId}.docSchema`, docEntry.hash);
	const page = entries.find((entry) => entry.id.endsWith(".rm"));
	if (!page) throw new Error(`Notebook ${docId} has no .rm page.`);
	const bytes = await api.getHash(page.id, page.hash);
	const { paragraphs, missing } = readTextPageRm(bytes);
	return {
		markdown: markdownFromParagraphs(paragraphs),
		paragraphCount: paragraphs.length,
		missing: missing === true,
	};
}
