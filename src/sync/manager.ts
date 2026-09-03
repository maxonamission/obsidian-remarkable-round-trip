import { PullQueue, PushQueue, PushWork, SyncQueueCoordinator } from "./queues";
import { WatchBatch, WatchQueue, WatchQueueOptions } from "./watcher";
import type { MirrorMode } from "../settingsmodel";
import type { MappingEntry, MappingTable } from "../id/mapping";

export interface MirrorSyncInput {
	localPath: string;
	localHash: string;
	expectedRemotePath: string;
	tracked?: {
		localPath: string;
		contentHash: string;
		localHash?: string;
		uploadedAt: string;
		deviceDocId: string;
	};
	remote?: {
		deviceDocId: string;
		remotePath: string;
		trashed?: boolean;
	} | null;
	legacyContentHash?: string;
	localModifiedAt?: number;
}

export type MirrorSyncDecision = "relocate" | "skip" | "upload";

export interface MirrorCandidate<T> {
	value: T;
	localPath: string;
	/** Hash of the source file, not its rendered output. */
	localHash: string;
	/** Pre-localHash mapping migration input. */
	legacyContentHash: string;
	localModifiedAt: number;
	expectedRemotePath: string;
	tracked?: MappingEntry;
}

export interface MirrorRemoteState {
	deviceDocId: string;
	remotePath: string;
	trashed?: boolean;
}

export interface MirrorBatchPlan<T, R extends MirrorRemoteState> {
	uploads: T[];
	relocations: {
		candidate: MirrorCandidate<T>;
		tracked: MappingEntry;
		remote: R;
	}[];
	trackingUpdates: MappingEntry[];
}

function localContentChanged(input: MirrorSyncInput): boolean {
	const { tracked } = input;
	if (tracked === undefined) return true;
	if (tracked.localHash !== undefined)
		return tracked.localHash !== input.localHash;
	const uploadedAt = Date.parse(tracked.uploadedAt);
	const changedAfterUpload =
		input.localModifiedAt === undefined ||
		!Number.isFinite(uploadedAt) ||
		input.localModifiedAt > uploadedAt;
	return changedAfterUpload && tracked.contentHash !== input.legacyContentHash;
}

export function decideMirrorSync(
	mode: MirrorMode,
	input: MirrorSyncInput,
): MirrorSyncDecision {
	const { tracked, remote } = input;
	if (tracked === undefined) return "upload";
	if (localContentChanged(input)) return "upload";
	if (tracked.localPath !== input.localPath)
		return remote == null ? "upload" : "relocate";
	if (mode === "strict") {
		if (remote == null) return "upload";
		if (remote.trashed === true) return "relocate";
		if (remote?.remotePath !== input.expectedRemotePath) return "relocate";
	}
	return "skip";
}

/** Owns debounce, push and pull scheduling for one plugin instance. */
export class SyncManager {
	private readonly coordinator = new SyncQueueCoordinator();
	private readonly pushes = new PushQueue(this.coordinator);
	private readonly pulls = new PullQueue(this.coordinator);
	private watcher: WatchQueue | null = null;

	configureWatcher(options: WatchQueueOptions | null): void {
		this.watcher?.dispose();
		this.watcher = options === null ? null : new WatchQueue(options);
	}

	noteChanged(path: string): void {
		this.watcher?.noteChanged(path);
	}

	notesChanged(paths: string[]): void {
		this.watcher?.notesChanged(paths);
	}

	notesRemoved(paths: string[]): void {
		this.watcher?.notesRemoved(paths);
	}

	noteRenamed(oldPath: string, newPath: string): void {
		this.watcher?.noteRenamed(oldPath, newPath);
	}

	noteRemoved(path: string): void {
		this.watcher?.noteRemoved(path);
	}

	enqueuePush(work: PushWork): Promise<void> {
		return this.pushes.enqueue(work);
	}

	async planMirrorBatch<T, R extends MirrorRemoteState>(
		mode: MirrorMode,
		candidates: MirrorCandidate<T>[],
		remoteFor: (tracked: MappingEntry) => Promise<R | null>,
		options: { remoteTreeUnchanged?: boolean } = {},
	): Promise<MirrorBatchPlan<T, R>> {
		const plan: MirrorBatchPlan<T, R> = {
			uploads: [],
			relocations: [],
			trackingUpdates: [],
		};
		for (const candidate of candidates) {
			const input: MirrorSyncInput = {
				localPath: candidate.localPath,
				localHash: candidate.localHash,
				expectedRemotePath: candidate.expectedRemotePath,
				tracked: candidate.tracked
					? {
							localPath: candidate.tracked.notePath,
							contentHash: candidate.tracked.contentHash,
							localHash: candidate.tracked.localHash,
							uploadedAt: candidate.tracked.uploadedAt,
							deviceDocId: candidate.tracked.deviceDocId,
						}
					: undefined,
				legacyContentHash: candidate.legacyContentHash,
				localModifiedAt: candidate.localModifiedAt,
			};
			const canUseRemoteCache =
				options.remoteTreeUnchanged === true &&
				candidate.tracked !== undefined &&
				candidate.tracked.remotePath !== undefined &&
				candidate.tracked.notePath === candidate.localPath &&
				!localContentChanged(input);
			const remote = !candidate.tracked
				? null
				: canUseRemoteCache
					? candidate.tracked.remotePath === null
						? null
						: ({
								deviceDocId: candidate.tracked.deviceDocId,
								remotePath: candidate.tracked.remotePath,
							} as R)
					: await remoteFor(candidate.tracked);
			const decision = decideMirrorSync(mode, { ...input, remote });
			if (decision === "upload") {
				plan.uploads.push(candidate.value);
			} else if (decision === "relocate" && candidate.tracked && remote) {
				plan.relocations.push({
					candidate,
					tracked: candidate.tracked,
					remote,
				});
			} else if (candidate.tracked) {
				plan.trackingUpdates.push({
					...candidate.tracked,
					localHash: candidate.localHash,
					remotePath: remote?.remotePath ?? null,
					lastSyncedAt: new Date().toISOString(),
				});
			}
		}
		return plan;
	}

	invalidateMirrorCache(table: MappingTable): MappingTable {
		return Object.fromEntries(
			Object.entries(table).map(([docId, entry]) => [
				docId,
				{ ...entry, lastSyncedAt: undefined },
			]),
		);
	}

	findExtraneousRemoteDocuments<T extends { deviceDocId: string }>(
		remoteDocuments: T[],
		expectedDeviceIds: ReadonlySet<string>,
	): T[] {
		return remoteDocuments.filter(
			(document) => !expectedDeviceIds.has(document.deviceDocId),
		);
	}

	findTrackedMapping(
		table: MappingTable,
		localPath: string,
		docId?: string,
	): MappingEntry | undefined {
		if (docId !== undefined && table[docId] !== undefined) return table[docId];
		return Object.values(table).find((entry) => entry.notePath === localPath);
	}

	enqueuePull(key: string, run: () => Promise<void>): Promise<void> {
		return this.pulls.enqueue(key, run);
	}

	runExclusive(run: () => Promise<void>): Promise<void> {
		return this.coordinator.enqueue("pull", run);
	}

	yieldToPush(): Promise<void> {
		return this.coordinator.yieldToPush();
	}

	dispose(): void {
		this.watcher?.dispose();
		this.watcher = null;
		this.coordinator.dispose();
	}
}

export type { WatchBatch };
