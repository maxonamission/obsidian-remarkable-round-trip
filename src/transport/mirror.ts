/**
 * Folder-mirroring transport on top of rmapi-js (GP_E2_S7, F4-rest).
 *
 * Design: docs/ontwerp-mapspiegeling.md (route C). The api surface we consume
 * is declared locally (structural typing) so tests inject a fake and the
 * rmapi-js instance satisfies it at the edge. The one deliberate exception is
 * the GenerationError class import below: recognising the library's own error
 * type by identity is the reliable signal (GP_E5_S1) and is worth the direct
 * coupling.
 */

import { GenerationError } from "rmapi-js";

import { TransportError } from "./http";
import { adviseFailure, classifyFailure } from "./failure";
import type { UploadResult } from "./cloud";
import type { DeviceIndex, FolderRecord } from "./deviceindex";

/** The slice of rmapi-js' RemarkableApi that mirroring needs. */
export interface MirrorApi {
	listItems(refresh?: boolean): Promise<MirrorEntry[]>;
	/** Ids and hashes only, no metadata (rmapi-js ≥ 14; was `listIds`). */
	listRefs?(refresh?: boolean): Promise<ItemRef[]>;
	getMetadata?(ref: ItemRef): Promise<{
		visibleName: string;
		createdTime?: string;
		lastModified?: string;
		pinned: boolean;
		parent: string;
		type: "CollectionType" | "DocumentType" | "TemplateType";
	}>;
	putFolder(
		visibleName: string,
		opts?: { parent?: string },
		refresh?: boolean,
	): Promise<{ id: string; hash: string }>;
	putPdf(
		visibleName: string,
		buffer: Uint8Array,
		opts?: { parent?: string; refresh?: boolean },
	): Promise<{ id: string; hash: string }>;
	putEpub(
		visibleName: string,
		buffer: Uint8Array,
		opts?: { parent?: string; refresh?: boolean },
	): Promise<{ id: string; hash: string }>;
	move(ref: ItemRef, parent: string, refresh?: boolean): Promise<unknown>;
}

/** rmapi-js ≥ 14 addresses an item by id and hash together (GP_E5_S28). */
export interface ItemRef {
	id: string;
	hash: string;
}

/**
 * Writing to the cloud means updating the account's shared root listing. If
 * anything else touched it in the meantime — the tablet syncing your fresh
 * annotations, a second client, another send — the server rejects the write
 * ("precondition failed" / "failed to upload root schema") and rmapi-js
 * raises a generation error. The library documents this as *expected*: you
 * refresh your view of the tree and try again (GP_E3_S4).
 */
export function isGenerationConflict(error: unknown): boolean {
	// The class check is the reliable signal. `error.name` is NOT: rmapi-js
	// never assigns `this.name`, so at runtime its GenerationError carries
	// name === "Error" (GP_E5_S1 — the name check below only catches wrappers
	// that set it deliberately).
	if (error instanceof GenerationError) return true;
	const name = error instanceof Error ? error.name : "";
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
	return (
		name === "GenerationError" ||
		// The strings cover the same condition reaching us as a plain server
		// message or re-wrapped error; "generation was stale" is the message
		// of rmapi-js' GenerationError itself.
		message.includes("generation was stale") ||
		message.includes("precondition failed") ||
		message.includes("root schema") ||
		message.includes("generation mismatch") ||
		message.includes("generation conflict")
	);
}

export interface RetryOptions {
	attempts?: number;
	backoffMs?: (attempt: number) => number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Run a cloud write, retrying on a generation conflict with a refreshed
 * view of the tree. `run(refresh)` is called with refresh=true from the
 * second attempt onwards.
 */
export async function withGenerationRetry<T>(
	run: (refresh: boolean) => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const attempts = options.attempts ?? 4;
	const backoffMs = options.backoffMs ?? ((attempt: number) => 300 * 2 ** (attempt - 1));
	const sleep =
		options.sleep ?? ((ms: number) => new Promise<void>((r) => window.setTimeout(r, ms)));

	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await run(attempt > 1);
		} catch (error) {
			lastError = error;
			if (attempt === attempts || !isGenerationConflict(error)) throw error;
			// Field diagnosability (GP_E5_S1): a console trail shows whether the
			// retry machinery engaged at all when a user reports a failure.
			console.warn(
				`reMarkable Round-Trip: cloud tree changed underneath us (generation conflict); retrying ${attempt + 1}/${attempts}`,
			);
			await sleep(backoffMs(attempt));
		}
	}
	throw lastError;
}

export interface MirrorEntry {
	id: string;
	hash: string;
	/** "CollectionType" | "DocumentType" | others (e.g. templates) — kept wide
	 * so the real rmapi-js Entry union stays structurally assignable. */
	type: string;
	visibleName: string;
	parent?: string;
	/** Milliseconds since epoch, as a string; picks the oldest of duplicates. */
	createdTime?: string;
	lastModified?: string;
}

/**
 * The oldest of several same-named folders (GP_E5_S30): by creation time,
 * then last change, then id, so every run picks the same one whatever order
 * the cloud lists them in. A folder without a time sorts last — the one this
 * run just created has none, and is never the user's original.
 */
function oldestFolder(folders: readonly MirrorEntry[]): MirrorEntry {
	const time = (value: string | undefined): number => {
		const parsed = Number(value);
		return value === undefined || value === "" || !Number.isFinite(parsed)
			? Number.POSITIVE_INFINITY
			: parsed;
	};
	return [...folders].sort(
		(a, b) =>
			time(a.createdTime) - time(b.createdTime) ||
			time(a.lastModified) - time(b.lastModified) ||
			a.id.localeCompare(b.id),
	)[0];
}

/**
 * Where a device document stands (GP_E5_S22). "unknown" is not "absent": the
 * account listing could not be read, so nothing may be concluded — and
 * nothing may be replaced or cleaned up on the strength of it.
 */
export type DocumentState =
	| { state: "present"; ref: ItemRef }
	| { state: "absent" }
	| { state: "unknown"; reason: string };

export class MirrorTransport {
	private items: MirrorEntry[] | null = null;
	/** path → collection id, cached per instance (one send-run). */
	private readonly folderIds = new Map<string, string>();
	/**
	 * Items whose metadata stayed unreadable after a second try, in the last
	 * listing. While there are any the listing is incomplete, and no folder
	 * may be created: the unreadable item could be the folder we were looking
	 * for (GP_E5_S30). They stay out of the device index, so the next run
	 * reads them again (GP_E5_S22).
	 */
	private unreadable = new Set<string>();
	/** What is known across runs about which items are folders (GP_E5_S24). */
	private readonly nonFolders: Set<string>;
	private readonly folderRecords: Map<string, FolderRecord>;
	/** Things the user should hear about after the send (duplicate folders). */
	readonly warnings: string[] = [];
	/** Progress while the library is read, item by item (GP_E5_S31). */
	onListing?: (done: number, total: number) => void;
	/** Called just before a missing folder is created (GP_E5_S31). */
	onCreateFolder?: (name: string) => void;
	private readonly warned = new Set<string>();

	constructor(
		private readonly api: MirrorApi,
		/** Device base folder under which the vault tree is mirrored ("" = root). */
		private readonly baseFolder: string,
		private readonly retry: RetryOptions = {},
		/** What an earlier run learned about the device's items (GP_E5_S24). */
		known: DeviceIndex = { nonFolders: [], folders: {} },
	) {
		this.nonFolders = new Set(known.nonFolders);
		this.folderRecords = new Map(Object.entries(known.folders));
	}

	/**
	 * The device index to keep for the next run (GP_E5_S24): only what this
	 * run could confirm, so it never holds an item the account no longer has.
	 */
	index(): DeviceIndex {
		return {
			nonFolders: [...this.nonFolders],
			folders: Object.fromEntries(this.folderRecords),
		};
	}

	/** Read one item's metadata into the index; false when it failed. */
	private async readItem({ id, hash }: ItemRef): Promise<boolean> {
		if (!this.api.getMetadata) return false;
		// One odd document must not sink the whole listing.
		try {
			const metadata = await this.api.getMetadata({ id, hash });
			if (metadata.type === "CollectionType") {
				const folder: FolderRecord = {
					hash,
					visibleName: metadata.visibleName,
					parent: metadata.parent ?? "",
				};
				if (metadata.createdTime !== undefined) folder.createdTime = metadata.createdTime;
				if (metadata.lastModified !== undefined) folder.lastModified = metadata.lastModified;
				this.folderRecords.set(id, folder);
			} else {
				this.folderRecords.delete(id);
				this.nonFolders.add(id);
			}
			return true;
		} catch (error) {
			console.warn(
				`reMarkable Round-Trip: device item ${id} — metadata unreadable: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	private async allItems(refresh = false): Promise<MirrorEntry[]> {
		if (this.items === null || refresh) {
			if (this.api.listRefs && this.api.getMetadata) {
				const refs = await this.api.listRefs(refresh);
				const present = new Map(refs.map((ref) => [ref.id, ref.hash]));
				// Forget what the account no longer has (GP_E5_S24).
				for (const id of [...this.nonFolders]) {
					if (!present.has(id)) this.nonFolders.delete(id);
				}
				for (const id of [...this.folderRecords.keys()]) {
					if (!present.has(id)) this.folderRecords.delete(id);
				}
				// Only new items and folders that changed since they were read.
				const toRead = refs.filter(
					(ref) =>
						!this.nonFolders.has(ref.id) &&
						this.folderRecords.get(ref.id)?.hash !== ref.hash,
				);
				const failed: ItemRef[] = [];
				if (toRead.length > 0) this.onListing?.(0, toRead.length);
				for (const [index, ref] of toRead.entries()) {
					if (!(await this.readItem(ref))) failed.push(ref);
					this.onListing?.(index + 1, toRead.length);
				}
				// A second chance at the end (GP_E5_S30): a network hiccup or a
				// rate-limit burst has usually passed by then.
				const unreadable = new Set<string>();
				for (const ref of failed) {
					if (!(await this.readItem(ref))) unreadable.add(ref.id);
				}
				// A folder that changed but could not be read is not trusted
				// from its old record; it is read again next time.
				for (const id of unreadable) this.folderRecords.delete(id);
				this.unreadable = unreadable;
				this.items = refs.flatMap((ref): MirrorEntry[] => {
					const folder = this.folderRecords.get(ref.id);
					if (folder === undefined || folder.hash !== ref.hash) return [];
					return [{ ...folder, id: ref.id, hash: ref.hash, type: "CollectionType" }];
				});
			} else {
				this.unreadable = new Set();
				this.items = await this.api.listItems(refresh);
			}
		}
		return this.items;
	}

	/** Drop cached views so the next call sees the server's current tree. */
	private invalidate(): void {
		this.items = null;
		this.folderIds.clear();
	}

	private async findOrCreateFolder(
		name: string,
		parent: string,
		refresh = false,
	): Promise<string> {
		const items = await this.allItems(refresh);
		const matches = items.filter(
			(e) =>
				e.type === "CollectionType" &&
				e.visibleName === name &&
				(e.parent ?? "") === parent,
		);
		if (matches.length > 0) {
			if (matches.length > 1) this.warnDuplicate(name, parent, matches.length);
			return oldestFolder(matches).id;
		}
		// Unreadable is not absent (GP_E5_S30). Creating the folder now could
		// make a second one next to the original the listing failed to read —
		// documents then split over both. Rather send nothing.
		if (this.unreadable.size > 0) {
			throw new TransportError(
				`${this.unreadable.size} item(s) in your reMarkable library could not be read, ` +
					`so the folder "${name}" was not created: it may already exist, and ` +
					"creating it again would make a duplicate. Try again in a moment.",
			);
		}
		this.onCreateFolder?.(name);
		const created = await withGenerationRetry(
			(retryRefresh) => this.api.putFolder(name, { parent }, retryRefresh),
			this.retry,
		);
		// Keep the local view consistent for subsequent lookups in this run.
		this.items?.push({
			id: created.id,
			hash: created.hash,
			type: "CollectionType",
			visibleName: name,
			parent,
		});
		// The hash the write returned, not a later read (GP_E5_S24): a change
		// on the tablet after this moment gives a different hash, and the next
		// run reads the folder again.
		this.folderRecords.set(created.id, { hash: created.hash, visibleName: name, parent });
		return created.id;
	}

	private warnDuplicate(name: string, parent: string, count: number): void {
		const key = `${parent}/${name}`;
		if (this.warned.has(key)) return;
		this.warned.add(key);
		this.warnings.push(
			`Your reMarkable has ${count} folders named "${name}" in the same place. ` +
				"The oldest one is used. Move the documents from the others into it " +
				"and delete the empty ones.",
		);
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

	/** Upload a document into the given collection ("" = root). */
	async upload(
		fileName: string,
		bytes: Uint8Array,
		options: { parentId?: string; format?: "pdf" | "epub" } = {},
	): Promise<UploadResult> {
		const { parentId = "", format = "pdf" } = options;
		const visibleName = fileName.replace(/\.(pdf|epub)$/i, "");
		const entry = await withGenerationRetry((refresh) => {
			// A retry means the tree moved under us; our cached folder ids may
			// be stale too, so drop them before trying again.
			if (refresh) this.invalidate();
			const opts = { parent: parentId, refresh };
			return format === "epub"
				? this.api.putEpub(visibleName, bytes, opts)
				: this.api.putPdf(visibleName, bytes, opts);
		}, this.retry);
		// A document is never a folder; no need to read it next time.
		this.nonFolders.add(entry.id);
		return { deviceDocId: entry.id, hash: entry.hash };
	}

	/**
	 * Where a device document stands, from the account's list of ids and
	 * hashes (GP_E5_S22). That list comes in one piece or not at all, so
	 * presence never depends on reading the document's own metadata: an
	 * item whose metadata is unreadable is still "present".
	 */
	async documentState(deviceDocId: string, refresh = false): Promise<DocumentState> {
		try {
			if (this.api.listRefs) {
				const refs = await this.api.listRefs(refresh);
				const ref = refs.find((candidate) => candidate.id === deviceDocId);
				return ref ? { state: "present", ref } : { state: "absent" };
			}
			const items = await this.allItems(refresh);
			const doc = items.find((e) => e.id === deviceDocId);
			return doc ? { state: "present", ref: { id: doc.id, hash: doc.hash } } : { state: "absent" };
		} catch (error) {
			return {
				state: "unknown",
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Move a previously uploaded document to the trash (idempotent re-send,
	 * N3): recoverable for the user, so safer than a hard delete. A document
	 * already gone from the account is fine. When it cannot be checked or
	 * moved, it is left alone and this throws, so the send can say so
	 * (GP_E5_S22) — "unknown" is never treated as "gone".
	 */
	async trashPrevious(deviceDocId: string): Promise<void> {
		await withGenerationRetry(async (refresh) => {
			// Look the reference up inside the retry: after a conflict the
			// document's hash may have changed (the tablet synced ink to it).
			const found = await this.documentState(deviceDocId, refresh);
			if (found.state === "absent") return;
			if (found.state === "unknown") throw new Error(found.reason);
			// Defence in depth (security-review): a mapped id is always one of
			// our own uploads, but a folder is never trashed on its strength.
			if (this.folderRecords.has(deviceDocId)) {
				throw new Error("the id belongs to a folder, not a document");
			}
			await this.api.move(found.ref, "trash", refresh);
		}, this.retry);
	}
}

/** Map rmapi-js failures onto our actionable error type (N3). */
export function toTransportError(error: unknown): TransportError {
	if (error instanceof TransportError) return error;
	const message = error instanceof Error ? error.message : String(error);
	if (isGenerationConflict(error)) {
		return new TransportError(
			"The reMarkable cloud was busy syncing (your tablet or another app was " +
				"writing at the same time), so the upload was refused. Nothing was lost — " +
				"wait until the tablet finishes syncing and send again.",
		);
	}
	// A network or credential failure is not a mirroring problem, and telling
	// someone to switch mirroring off would not help them (GP_E3_S10).
	const kind = classifyFailure(error);
	if (kind !== "unknown") {
		return new TransportError(`${message}. ${adviseFailure(kind)}`);
	}
	return new TransportError(
		`Folder mirroring failed (${message}). ` +
			"You can disable 'Mirror vault folders' in the settings to fall back to root uploads.",
	);
}
