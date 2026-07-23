/**
 * Send orchestration (PRD F1, F8-basis): note → preprocess → PDF → upload,
 * with per-file results for batch runs. Pure logic over injected adapters so
 * the whole flow is unit-testable without Obsidian or a device.
 */

import { preprocess, EmbedResolver } from "../preprocess/preprocess";
import { parseBlocks } from "../convert/mdblocks";
import { renderPdf, PdfLayoutOptions } from "../convert/pdf";
import { ensureDocId } from "../id/docid";
import { MappingTable, contentHash, recordUpload } from "../id/mapping";
import type { UploadResult } from "../transport/cloud";

/** Vault access seam: the plugin edge adapts TFile/Vault to this shape. */
export interface NoteInput {
	path: string;
	basename: string;
	content: string;
	/** Current frontmatter value of the docId key, if any. */
	existingDocId?: unknown;
}

export interface SendDeps {
	client: {
		uploadPdf(
			fileName: string,
			pdfBytes: Uint8Array,
			parentId?: string,
		): Promise<UploadResult>;
	};
	/** Resolve an embed for a given note (notePath disambiguates targets). */
	resolveEmbed: (linkpath: string, notePath: string) => ReturnType<EmbedResolver>;
	/** Persist a newly generated docId into the note's frontmatter. */
	persistDocId: (note: NoteInput, docId: string) => Promise<void>;
	/**
	 * Device collection for this note (folder mirroring, GP_E2_S7); omit for
	 * root uploads.
	 */
	resolveParent?: (notePath: string) => Promise<string>;
	/**
	 * Retire the previous device copy after a successful re-upload
	 * (idempotent re-send, N3). Failures are non-fatal: the old copy then
	 * simply lingers, which is the pre-mirroring behavior.
	 */
	replacePrevious?: (previousDeviceDocId: string) => Promise<void>;
	layout?: PdfLayoutOptions;
	frontmatterAsTitleBlock?: boolean;
	/**
	 * Skip the upload when the preprocessed content matches the recorded
	 * hash of the last upload (watch-folder flow, F6).
	 */
	skipUnchanged?: boolean;
}

export interface SendSuccess {
	ok: true;
	path: string;
	docId: string;
	deviceDocId: string;
	missingEmbeds: string[];
	/** True when the note was up to date and no upload happened. */
	skipped?: boolean;
}

export interface SendFailure {
	ok: false;
	path: string;
	error: string;
}

export type SendResult = SendSuccess | SendFailure;

/** Send one note; never throws — failures come back as a result (F8). */
export async function sendNote(
	note: NoteInput,
	table: MappingTable,
	deps: SendDeps,
): Promise<{ result: SendResult; table: MappingTable }> {
	try {
		const { docId, isNew } = ensureDocId(note.existingDocId);
		if (isNew) await deps.persistDocId(note, docId);

		const pre = preprocess(note.content, {
			resolveEmbed: (linkpath) => deps.resolveEmbed(linkpath, note.path),
			frontmatterAsTitleBlock: deps.frontmatterAsTitleBlock,
		});
		const hash = contentHash(pre.markdown);
		if (deps.skipUnchanged && table[docId]?.contentHash === hash) {
			return {
				result: {
					ok: true,
					path: note.path,
					docId,
					deviceDocId: table[docId].deviceDocId,
					missingEmbeds: pre.missingEmbeds,
					skipped: true,
				},
				table,
			};
		}
		const blocks = parseBlocks(pre.markdown);
		const pdf = await renderPdf(blocks, { title: note.basename, docId }, deps.layout);
		const parentId = deps.resolveParent
			? await deps.resolveParent(note.path)
			: undefined;
		const upload = await deps.client.uploadPdf(`${note.basename}.pdf`, pdf, parentId);

		const previous = table[docId];
		if (
			deps.replacePrevious &&
			previous !== undefined &&
			previous.deviceDocId !== upload.deviceDocId
		) {
			try {
				await deps.replacePrevious(previous.deviceDocId);
			} catch {
				// Non-fatal: the old device copy lingers (pre-mirroring behavior).
			}
		}

		const updated = recordUpload(table, {
			docId,
			notePath: note.path,
			deviceDocId: upload.deviceDocId,
			contentHash: hash,
		});
		return {
			result: {
				ok: true,
				path: note.path,
				docId,
				deviceDocId: upload.deviceDocId,
				missingEmbeds: pre.missingEmbeds,
			},
			table: updated,
		};
	} catch (error) {
		return {
			result: {
				ok: false,
				path: note.path,
				error: error instanceof Error ? error.message : String(error),
			},
			table,
		};
	}
}

/** Send a batch sequentially; one failure never aborts the rest (F8). */
export async function sendBatch(
	notes: NoteInput[],
	table: MappingTable,
	deps: SendDeps,
	onProgress?: (done: number, total: number, current: SendResult) => void,
): Promise<{ results: SendResult[]; table: MappingTable }> {
	const results: SendResult[] = [];
	let current = table;
	for (const note of notes) {
		const { result, table: updated } = await sendNote(note, current, deps);
		current = updated;
		results.push(result);
		onProgress?.(results.length, notes.length, result);
	}
	return { results, table: current };
}
