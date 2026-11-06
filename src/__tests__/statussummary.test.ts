import { describe, expect, it } from "vitest";
import { buildSyncStatusSummary } from "../sync/statussummary";

describe("buildSyncStatusSummary", () => {
	it("summarises persisted coverage and live queue state", () => {
		const summary = buildSyncStatusSummary({
			mappings: {
				a: {
					docId: "a",
					notePath: "watch/a.md",
					deviceDocId: "remote-a",
					uploadedAt: "2026-09-01T10:00:00Z",
					contentHash: "a",
				},
				b: {
					docId: "b",
					notePath: "missing.md",
					deviceDocId: "remote-b",
					uploadedAt: "2026-09-03T10:00:00Z",
					contentHash: "b",
				},
			},
			localPaths: new Set(["watch/a.md", "watch/new.md"]),
			watchPaths: new Set(["watch/a.md", "watch/new.md"]),
			live: {
				active: "push",
				activeSince: null,
				queuedFolders: 1,
				queuedPushes: 2,
				queuedPulls: 3,
				pendingChanges: 4,
			},
		});

		expect(summary).toEqual({
			queue: "Uploading",
			queuedWork: 6,
			canReset: true,
			pendingChanges: 4,
			trackedNotes: 2,
			localTrackedNotes: 1,
			missingLocalNotes: 1,
			watchNotes: 2,
			untrackedWatchNotes: 1,
			lastUploadedAt: "2026-09-03T10:00:00Z",
		});
	});

	// GP_E5_S27: "Uploading" alone cannot tell slow from stuck.
	const live = (over: Partial<Parameters<typeof buildSyncStatusSummary>[0]["live"]>) => ({
		active: null,
		activeSince: null,
		queuedFolders: 0,
		queuedPushes: 0,
		queuedPulls: 0,
		pendingChanges: 0,
		...over,
	});
	const summarise = (over: Parameters<typeof live>[0], now = 0) =>
		buildSyncStatusSummary({
			mappings: {},
			localPaths: new Set(),
			watchPaths: new Set(),
			live: live(over),
			now,
		});

	it("says how long the running task has been at it", () => {
		const start = Date.parse("2026-11-06T10:00:00Z");
		expect(summarise({ active: "pull", activeSince: start }, start + 30_000).queue).toBe(
			"Importing (running for less than a minute)",
		);
		expect(
			summarise({ active: "push", activeSince: start }, start + 9 * 60_000 + 5_000).queue,
		).toBe("Uploading (running for 9 min)");
	});

	it("offers a reset only when something runs or waits", () => {
		expect(summarise({}).canReset).toBe(false);
		expect(summarise({ pendingChanges: 2 }).canReset).toBe(false);
		expect(summarise({ queuedPulls: 1 }).canReset).toBe(true);
		expect(summarise({ active: "folder", activeSince: 0 }).canReset).toBe(true);
	});
});
