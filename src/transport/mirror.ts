/**
 * Folder-mirroring transport on top of rmapi-js (GP_E2_S7, F4-rest).
 *
 * Design: docs/ontwerp-mapspiegeling.md (route C). The api surface we consume
 * is declared locally (structural typing) so tests inject a fake and the
 * rmapi-js instance satisfies it at the edge.
 */

import { GenerationError } from "rmapi-js";

import { TransportError } from "./http";
import { adviseFailure, classifyFailure } from "./failure";
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
		opts?: { parent?: string; refresh?: boolean },
	): Promise<{ id: string; hash: string }>;
	putEpub(
		visibleName: string,
		buffer: Uint8Array,
		opts?: { parent?: string; refresh?: boolean },
	): Promise<{ id: string; hash: string }>;
	move(hash: string, parent: string, refresh?: boolean): Promise<unknown>;
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
}

export class MirrorTransport {
	private items: MirrorEntry[] | null = null;
	/** path → collection id, cached per instance (one send-run). */
	private readonly folderIds = new Map<string, string>();

	constructor(
		private readonly api: MirrorApi,
		/** Device base folder under which the vault tree is mirrored ("" = root). */
		private readonly baseFolder: string,
		private readonly retry: RetryOptions = {},
	) {}

	private async allItems(refresh = false): Promise<MirrorEntry[]> {
		if (this.items === null || refresh) {
			this.items = await this.api.listItems(refresh);
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
		const existing = items.find(
			(e) =>
				e.type === "CollectionType" &&
				e.visibleName === name &&
				(e.parent ?? "") === parent,
		);
		if (existing) return existing.id;
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
		await withGenerationRetry(
			(refresh) => this.api.move(doc.hash, "trash", refresh),
			this.retry,
		);
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
