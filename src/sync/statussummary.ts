import type { MappingTable } from "../id/mapping";
import type { SyncQueueStatus } from "./queues";

export interface LiveSyncStatus extends SyncQueueStatus {
	pendingChanges: number;
}

export interface SyncStatusSummary {
	queue: string;
	queuedWork: number;
	pendingChanges: number;
	trackedNotes: number;
	localTrackedNotes: number;
	missingLocalNotes: number;
	watchNotes: number;
	untrackedWatchNotes: number;
	lastUploadedAt: string | null;
}

export function buildSyncStatusSummary(input: {
	mappings: MappingTable;
	localPaths: ReadonlySet<string>;
	watchPaths: ReadonlySet<string>;
	live: LiveSyncStatus;
}): SyncStatusSummary {
	const entries = Object.values(input.mappings);
	const mappedPaths = new Set(entries.map((entry) => entry.notePath));
	const localTrackedNotes = entries.filter((entry) =>
		input.localPaths.has(entry.notePath),
	).length;
	const syncTimes = entries.map((entry) => entry.uploadedAt).sort();
	const lastUploadedAt = syncTimes[syncTimes.length - 1] ?? null;
	const queue =
		input.live.active === "folder"
			? "Preparing device folders"
			: input.live.active === "push"
				? "Uploading"
				: input.live.active === "pull"
					? "Importing"
					: input.live.queuedFolders +
								input.live.queuedPushes +
								input.live.queuedPulls >
							0
						? "Queued"
						: input.live.pendingChanges > 0
							? "Waiting for debounce"
							: "Idle";

	return {
		queue,
		queuedWork:
			input.live.queuedFolders +
			input.live.queuedPushes +
			input.live.queuedPulls,
		pendingChanges: input.live.pendingChanges,
		trackedNotes: entries.length,
		localTrackedNotes,
		missingLocalNotes: entries.length - localTrackedNotes,
		watchNotes: input.watchPaths.size,
		untrackedWatchNotes: [...input.watchPaths].filter(
			(path) => !mappedPaths.has(path),
		).length,
		lastUploadedAt,
	};
}
