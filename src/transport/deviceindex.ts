/**
 * What the plugin remembers about the items on the reMarkable between runs
 * (GP_E5_S24), so a send does not read the metadata of every item again.
 *
 * The sync API lists every item as an id plus a hash, in one request. Reading
 * an item's metadata costs one request per item; with hundreds of documents
 * that is slow and invites rate limits (GP_E5_S21). Mirroring only needs to
 * know which items are folders, and what those folders are called and where
 * they sit. Two facts make a cache safe:
 *
 * - An item's type never changes. Once an id is known as "not a folder", it
 *   never needs reading again.
 * - An item's hash changes whenever its metadata changes. A folder is only
 *   trusted from the cache while its hash in the current listing equals the
 *   cached one; a rename or move on the tablet gives a new hash, and the
 *   folder is read again.
 *
 * So a stale or partial index cannot hide a change: every entry is checked
 * against the current listing. Items that could not be read are not stored,
 * and are tried again next time (GP_E5_S22).
 *
 * Stored in data.json next to the mappings. It holds folder names and ids
 * only; never document names or content.
 */

export interface FolderRecord {
	/** The folder's hash when this record was read or written. */
	hash: string;
	visibleName: string;
	/** Parent folder id; "" = top level, "trash" = in the trash. */
	parent: string;
	createdTime?: string;
	lastModified?: string;
}

export interface DeviceIndex {
	/** Ids known to be no folder: documents and templates. */
	nonFolders: string[];
	/** Folder id → what was read about it. */
	folders: Record<string, FolderRecord>;
}

const isString = (value: unknown): value is string => typeof value === "string";

function folderFrom(value: unknown): FolderRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (!isString(record.hash) || !isString(record.visibleName) || !isString(record.parent)) {
		return undefined;
	}
	const folder: FolderRecord = {
		hash: record.hash,
		visibleName: record.visibleName,
		parent: record.parent,
	};
	if (isString(record.createdTime)) folder.createdTime = record.createdTime;
	if (isString(record.lastModified)) folder.lastModified = record.lastModified;
	return folder;
}

/**
 * Read a stored index defensively. data.json can be edited by hand, synced
 * from another version, or damaged; anything malformed is dropped, which only
 * costs a re-read of those items.
 */
export function parseDeviceIndex(value: unknown): DeviceIndex {
	if (typeof value !== "object" || value === null) return { nonFolders: [], folders: {} };
	const stored = value as Record<string, unknown>;
	const nonFolders = Array.isArray(stored.nonFolders) ? stored.nonFolders.filter(isString) : [];
	const entries =
		typeof stored.folders === "object" && stored.folders !== null
			? Object.entries(stored.folders as Record<string, unknown>)
			: [];
	// fromEntries defines own properties, so a hand-edited "__proto__" key
	// stays an ordinary (and harmless) entry instead of a prototype change.
	const folders = Object.fromEntries(
		entries.flatMap(([id, raw]): [string, FolderRecord][] => {
			const folder = folderFrom(raw);
			return folder ? [[id, folder]] : [];
		}),
	);
	return { nonFolders: [...new Set(nonFolders)], folders };
}
