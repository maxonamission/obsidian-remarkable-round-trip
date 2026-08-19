/**
 * Local mapping store: document ID ↔ device document (PRD F5, foundation for
 * F10–F14). Persisted through the plugin's data.json (caller injects
 * load/save); pure logic lives here for testability.
 */

export interface MappingEntry {
	/** Stable document ID from the note's frontmatter. */
	docId: string;
	/** Vault path of the source note at upload time (informational only). */
	notePath: string;
	/** Document UUID assigned by the reMarkable cloud on upload. */
	deviceDocId: string;
	/** ISO timestamp of the last upload. */
	uploadedAt: string;
	/** Simple content hash of the uploaded (preprocessed) markdown. */
	contentHash: string;
	/**
	 * What was delivered (GP_E7_S2): "pdf"/"epub" review copies, or "text" —
	 * a write-mode notebook whose import is the write-mode route, not the
	 * annotation pull. Absent = a pre-0.36 upload, always a review copy.
	 */
	format?: "pdf" | "epub" | "text";
	/**
	 * Device document hash at the last annotation import (F10). Unset until
	 * the first import; equal to the current device hash means "nothing new".
	 */
	importedHash?: string;
	/**
	 * Typography of this upload (GP_E3_S8). The layout map itself is far too
	 * big to keep here, so the import reproduces it from the note plus these
	 * numbers — which stays correct even if the settings changed since.
	 * Absent for EPUB: a reflowing document has no fixed geometry to anchor to.
	 * `typo` records the typesetter behaviour version (GP_E5_S4–S7); absent
	 * means version 1 (sent before 0.29.0).
	 */
	pdfLayout?: {
		fontSize: number;
		lineHeight: number;
		margin: number;
		typo?: number;
		/** Page size of this upload (GP_E6_S2); absent = reMarkable 1/2 screen. */
		pageWidth?: number;
		pageHeight?: number;
		/** Heading level up to which pages broke (GP_E6_S4); absent = 0. */
		breakAtHeading?: number;
		/** Whether #/## sections were packed (GP_E6_S9); absent = false. */
		packSections?: boolean;
	};
}

export type MappingTable = Record<string, MappingEntry>;

/** FNV-1a 32-bit hash — enough to detect "note changed since upload" (F14). */
export function contentHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Record a fresh upload. `importedHash` is deliberately *not* carried over:
 * a re-send creates a new document on the device, so an import marker from
 * the previous copy would wrongly suppress the next annotation import.
 */
export function recordUpload(
	table: MappingTable,
	entry: Omit<MappingEntry, "uploadedAt"> & { uploadedAt?: string },
): MappingTable {
	return {
		...table,
		[entry.docId]: {
			...entry,
			importedHash: undefined,
			uploadedAt: entry.uploadedAt ?? new Date().toISOString(),
		},
	};
}

export function lookupByDocId(table: MappingTable, docId: string): MappingEntry | undefined {
	return table[docId];
}

export function lookupByDeviceDocId(
	table: MappingTable,
	deviceDocId: string,
): MappingEntry | undefined {
	return Object.values(table).find((e) => e.deviceDocId === deviceDocId);
}
