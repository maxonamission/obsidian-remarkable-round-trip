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

export function recordUpload(
	table: MappingTable,
	entry: Omit<MappingEntry, "uploadedAt"> & { uploadedAt?: string },
): MappingTable {
	return {
		...table,
		[entry.docId]: {
			...entry,
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
