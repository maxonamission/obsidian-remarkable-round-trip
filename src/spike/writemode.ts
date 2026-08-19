/**
 * Spike GP_E7_S1, assumption 1 + 3: upload a typed-text notebook through the
 * cloud API and read the (possibly edited) text back.
 *
 * The bundle mirrors what rmapi-js' own putPdf uploads — content, metadata,
 * pagedata, the payload file, one entries list, root update — with two
 * notebook-specific differences: the payload is a `{docId}/{pageId}.rm` page
 * (not `{docId}.pdf`) and the content JSON says `fileType: "notebook"` with
 * the page listed in `pages`. Content goes up via putText, not putContent: the spike
 * must learn what the DEVICE accepts, not what rmapi-js' validator expects.
 *
 * Spike code: exercised only by the hidden spike command; not part of any
 * user-facing path.
 */

import {
	PARAGRAPH_STYLE,
	type TextParagraph,
	buildTextPageRm,
	readTextPageRm,
} from "./rmtext";

/** The slice of rmapi-js' raw api the spike consumes (structural, testable). */
export interface SpikeRawApi {
	getRootHash(): Promise<[string, number, number]>;
	getEntries(id: string, hash: string): Promise<{ entries: SpikeEntry[] }>;
	getHash(id: string, hash: string): Promise<Uint8Array>;
	putFile(id: string, bytes: Uint8Array): Promise<[SpikeEntry, Promise<void>]>;
	putText(id: string, content: string): Promise<[SpikeEntry, Promise<void>]>;
	putEntries(
		id: string,
		entries: readonly SpikeEntry[],
		schemaVersion: number,
	): Promise<[SpikeEntry, Promise<void>]>;
	putRootHash(hash: string, generation: number): Promise<[string, number]>;
}

export interface SpikeEntry {
	id: string;
	hash: string;
}

/**
 * Markdown → device paragraphs, F18 subset: `#`/`##` → heading, whole-line
 * bold → bold, `- ` → bullet, `- [ ]`/`- [x]` → checkbox; everything else
 * plain, markers preserved as literal text so nothing is lost (F17).
 */
export function paragraphsFromMarkdown(markdown: string): TextParagraph[] {
	return markdown
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line): TextParagraph => {
			const heading = line.match(/^#{1,2}\s+(.*)$/);
			if (heading) return { text: heading[1], style: PARAGRAPH_STYLE.heading };
			const checked = line.match(/^- \[x\]\s+(.*)$/i);
			if (checked) return { text: checked[1], style: PARAGRAPH_STYLE.checkboxChecked };
			const open = line.match(/^- \[ \]\s+(.*)$/);
			if (open) return { text: open[1], style: PARAGRAPH_STYLE.checkbox };
			const bullet = line.match(/^[-*]\s+(.*)$/);
			if (bullet) return { text: bullet[1], style: PARAGRAPH_STYLE.bullet };
			const bold = line.match(/^\*\*([^*]+)\*\*$/);
			if (bold) return { text: bold[1], style: PARAGRAPH_STYLE.bold };
			return { text: line, style: PARAGRAPH_STYLE.plain };
		});
}

/** Device paragraphs → markdown, the reverse of `paragraphsFromMarkdown`. */
export function markdownFromParagraphs(paragraphs: TextParagraph[]): string {
	const line = (p: TextParagraph): string => {
		switch (p.style) {
			case PARAGRAPH_STYLE.heading:
				return `## ${p.text}`;
			case PARAGRAPH_STYLE.bold:
				return `**${p.text}**`;
			case PARAGRAPH_STYLE.bullet:
			case PARAGRAPH_STYLE.bullet2:
				return `- ${p.text}`;
			case PARAGRAPH_STYLE.checkbox:
				return `- [ ] ${p.text}`;
			case PARAGRAPH_STYLE.checkboxChecked:
				return `- [x] ${p.text}`;
			default:
				return p.text;
		}
	};
	return paragraphs.map(line).join("\n");
}

export interface SpikeUploadResult {
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

/**
 * Upload `markdown` as an editable typed-text notebook (assumption 1).
 * Follows rmapi-js' own upload sequence; the generation-conflict retry from
 * the mirroring path is NOT reused here on purpose — a spike failure should
 * surface raw, not be smoothed over.
 */
export async function uploadTextNotebook(
	api: SpikeRawApi,
	visibleName: string,
	markdown: string,
	now: () => number = Date.now,
): Promise<SpikeUploadResult> {
	const docId = uuid4();
	const pageId = uuid4();
	const rm = buildTextPageRm(paragraphsFromMarkdown(markdown));
	const timestamp = now().toFixed();

	const metadata = {
		parent: "",
		pinned: false,
		lastModified: timestamp,
		createdTime: timestamp,
		type: "DocumentType",
		visibleName,
		lastOpened: timestamp,
		lastOpenedPage: 0,
	};
	// A notebook's content: fileType "notebook" — the device-bevinding van
	// 2026-08-19: een lege string valideert in geen enkele tak van rmapi-js'
	// content-union, waardoor elke listItems (mapspiegeling!) op het
	// spike-document stukliep zodra het in het account stond.
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

	const [rootEntry, uploadRoot] = await api.putEntries(
		"root",
		[...rootEntries, collectionEntry],
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

export interface SpikeReadResult {
	markdown: string;
	paragraphCount: number;
	/** True when the page carried no root-text block (pure ink page). */
	missing: boolean;
}

/** Read the (possibly edited) text of a spike notebook back (assumption 3). */
export async function readTextNotebook(
	api: SpikeRawApi,
	docId: string,
): Promise<SpikeReadResult> {
	const [rootHash] = await api.getRootHash();
	const { entries: rootEntries } = await api.getEntries("root.docSchema", rootHash);
	const docEntry = rootEntries.find((entry) => entry.id === docId);
	if (!docEntry) throw new Error(`Spike notebook ${docId} not found in the account root.`);
	const { entries } = await api.getEntries(`${docId}.docSchema`, docEntry.hash);
	const page = entries.find((entry) => entry.id.endsWith(".rm"));
	if (!page) throw new Error(`Spike notebook ${docId} has no .rm page.`);
	const bytes = await api.getHash(page.id, page.hash);
	const { paragraphs, missing } = readTextPageRm(bytes);
	return {
		markdown: markdownFromParagraphs(paragraphs),
		paragraphCount: paragraphs.length,
		missing: missing === true,
	};
}
