import type { MappingTable } from "../id/mapping";
import type { SyncQueueStatus } from "./queues";

export interface LiveSyncStatus extends SyncQueueStatus {
	pendingChanges: number;
}

export interface SyncStatusSummary {
	queue: string;
	queuedWork: number;
	/** Something runs or waits, so resetting the queue would change anything. */
	canReset: boolean;
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
	/** Clock for the running time of the active task; injected for tests. */
	now?: number;
}): SyncStatusSummary {
	const entries = Object.values(input.mappings);
	const mappedPaths = new Set(entries.map((entry) => entry.notePath));
	const localTrackedNotes = entries.filter((entry) =>
		input.localPaths.has(entry.notePath),
	).length;
	const syncTimes = entries.map((entry) => entry.uploadedAt).sort();
	const lastUploadedAt = syncTimes[syncTimes.length - 1] ?? null;
	const queuedWork =
		input.live.queuedFolders + input.live.queuedPushes + input.live.queuedPulls;
	const activeLabel =
		input.live.active === "folder"
			? "Preparing device folders"
			: input.live.active === "push"
				? "Uploading"
				: input.live.active === "pull"
					? "Importing"
					: null;
	const queue =
		activeLabel !== null
			? `${activeLabel}${runningFor(input.live.activeSince, input.now)}`
			: queuedWork > 0
				? "Queued"
				: input.live.pendingChanges > 0
					? "Waiting for debounce"
					: "Idle";

	return {
		queue,
		queuedWork,
		canReset: activeLabel !== null || queuedWork > 0,
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

/**
 * How long the running task has been at it (GP_E5_S27). "Uploading" alone
 * cannot tell a slow first walk of the device tree from a task that will
 * never finish; a running time can.
 */
function runningFor(since: number | null | undefined, now = Date.now()): string {
	if (since === null || since === undefined) return "";
	const minutes = Math.floor(Math.max(0, now - since) / 60_000);
	return minutes < 1
		? " (running for less than a minute)"
		: ` (running for ${minutes} min)`;
}
