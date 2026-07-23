/**
 * Folder-mirroring transport on top of rmapi-js (GP_E2_S7, F4-rest).
 *
 * Design: docs/ontwerp-mapspiegeling.md (route C). The api surface we consume
 * is declared locally (structural typing) so tests inject a fake and the
 * rmapi-js instance satisfies it at the edge.
 */

import { TransportError } from "./http";
import type { UploadResult } from "./cloud";

/** The slice of rmapi-js' RemarkableApi that mirroring needs. */
export interface MirrorApi {
	listItems(refresh?: boolean): Promise<MirrorEntry[]>;
	putFolder(
		visibleName: string,
		opts?: { parent?: string },
		refresh?: boolean,
	): Promise<{ id: string; hash: string }>;
	putPdf(
		visibleName: string,
		buffer: Uint8Array,
		opts?: { parent?: string },
	): Promise<{ id: string; hash: string }>;
	move(hash: string, parent: string, refresh?: boolean): Promise<unknown>;
}

export interface MirrorEntry {
	id: string;
	hash: string;
	/** "CollectionType" | "DocumentType" | others (e.g. templates) — kept wide
	 * so the real rmapi-js Entry union stays structurally assignable. */
	type: string;
	visibleName: string;
	parent?: string;
}

export class MirrorTransport {
	private items: MirrorEntry[] | null = null;
	/** path → collection id, cached per instance (one send-run). */
	private readonly folderIds = new Map<string, string>();

	constructor(
		private readonly api: MirrorApi,
		/** Device base folder under which the vault tree is mirrored ("" = root). */
		private readonly baseFolder: string,
	) {}

	private async allItems(): Promise<MirrorEntry[]> {
		if (this.items === null) {
			this.items = await this.api.listItems();
		}
		return this.items;
	}

	private async findOrCreateFolder(name: string, parent: string): Promise<string> {
		const items = await this.allItems();
		const existing = items.find(
			(e) =>
				e.type === "CollectionType" &&
				e.visibleName === name &&
				(e.parent ?? "") === parent,
		);
		if (existing) return existing.id;
		const created = await this.api.putFolder(name, { parent });
		// Keep the local view consistent for subsequent lookups in this run.
		this.items?.push({
			id: created.id,
			hash: created.hash,
			type: "CollectionType",
			visibleName: name,
			parent,
		});
		return created.id;
	}

	/**
	 * Resolve the device collection for a vault folder path ("" = vault root),
	 * creating missing segments. Mirrors under the configured base folder.
	 */
	async ensureFolderPath(vaultFolderPath: string): Promise<string> {
		const segments = [
			...this.baseFolder.split("/").filter((s) => s !== ""),
			...vaultFolderPath.split("/").filter((s) => s !== ""),
		];
		const key = segments.join("/");
		const cached = this.folderIds.get(key);
		if (cached !== undefined) return cached;

		let parent = "";
		let prefix = "";
		for (const segment of segments) {
			prefix = prefix === "" ? segment : `${prefix}/${segment}`;
			const cachedSegment = this.folderIds.get(prefix);
			if (cachedSegment !== undefined) {
				parent = cachedSegment;
				continue;
			}
			parent = await this.findOrCreateFolder(segment, parent);
			this.folderIds.set(prefix, parent);
		}
		return parent;
	}

	/** Upload a PDF into the given collection ("" = root). */
	async uploadPdf(
		fileName: string,
		pdfBytes: Uint8Array,
		parentId: string,
	): Promise<UploadResult> {
		const visibleName = fileName.replace(/\.pdf$/i, "");
		const entry = await this.api.putPdf(visibleName, pdfBytes, { parent: parentId });
		return { deviceDocId: entry.id, hash: entry.hash };
	}

	/**
	 * Move a previously uploaded document to the trash (idempotent re-send,
	 * N3): recoverable for the user, so safer than a hard delete. Missing
	 * documents (already removed on-device) are silently fine.
	 */
	async trashPrevious(deviceDocId: string): Promise<void> {
		const items = await this.allItems();
		const doc = items.find((e) => e.type === "DocumentType" && e.id === deviceDocId);
		if (!doc) return;
		await this.api.move(doc.hash, "trash");
	}
}

/** Map rmapi-js failures onto our actionable error type (N3). */
export function toTransportError(error: unknown): TransportError {
	if (error instanceof TransportError) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new TransportError(
		`Folder mirroring failed (${message}). ` +
			"You can disable 'Mirror vault folders' in the settings to fall back to root uploads.",
	);
}
