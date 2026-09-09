import { describe, expect, it } from "vitest";
import { SyncManager, decideMirrorSync } from "../sync/manager";
import type { MappingEntry } from "../id/mapping";

const BASE = {
	localPath: "Projects/Plan.md",
	localHash: "local-hash",
	expectedRemotePath: "Obsidian/Projects/Plan",
	tracked: {
		localPath: "Projects/Plan.md",
		contentHash: "local-hash",
		localHash: "local-hash",
		uploadedAt: "2026-09-03T00:00:00Z",
		deviceDocId: "device-plan",
	},
	remote: {
		deviceDocId: "device-plan",
		remotePath: "Obsidian/Projects/Plan",
	},
};

describe("decideMirrorSync", () => {
	it("uploads new and locally changed notes in both modes", () => {
		expect(decideMirrorSync("strict", { ...BASE, tracked: undefined })).toBe(
			"upload",
		);
		expect(
			decideMirrorSync("push", {
				...BASE,
				localHash: "changed",
			}),
		).toBe("upload");
	});

	it("restores remote moves and deletions in strict mode", () => {
		expect(
			decideMirrorSync("strict", {
				...BASE,
				remote: { ...BASE.remote, remotePath: "Archive/Plan" },
			}),
		).toBe("relocate");
		expect(decideMirrorSync("strict", { ...BASE, remote: null })).toBe(
			"upload",
		);
		expect(
			decideMirrorSync("strict", {
				...BASE,
				remote: {
					...BASE.remote,
					remotePath: BASE.expectedRemotePath,
					trashed: true,
				},
			}),
		).toBe("relocate");
	});

	it("accepts remote moves and deletions in push mode while local is unchanged", () => {
		expect(
			decideMirrorSync("push", {
				...BASE,
				remote: { ...BASE.remote, remotePath: "Archive/Plan" },
			}),
		).toBe("skip");
		expect(decideMirrorSync("push", { ...BASE, remote: null })).toBe("skip");
	});

	it("propagates a local move by relocating an existing remote document", () => {
		expect(
			decideMirrorSync("push", {
				...BASE,
				localPath: "Moved/Plan.md",
				expectedRemotePath: "Obsidian/Moved/Plan",
			}),
		).toBe("relocate");
		expect(
			decideMirrorSync("push", {
				...BASE,
				localPath: "Moved/Plan.md",
				remote: null,
			}),
		).toBe("upload");
	});

	it("skips an unchanged aligned document", () => {
		expect(decideMirrorSync("strict", BASE)).toBe("skip");
		expect(decideMirrorSync("push", BASE)).toBe("skip");
	});
});

describe("SyncManager mirror planning", () => {
	const tracked: MappingEntry = {
		docId: "doc-plan",
		notePath: BASE.localPath,
		deviceDocId: "device-plan",
		uploadedAt: "2026-09-03T00:00:00Z",
		contentHash: BASE.localHash,
		localHash: BASE.localHash,
		remotePath: BASE.expectedRemotePath,
	};
	const candidate = {
		value: "plan",
		localPath: BASE.localPath,
		localHash: BASE.localHash,
		legacyContentHash: BASE.localHash,
		localModifiedAt: Date.parse("2026-09-03T00:00:00Z"),
		expectedRemotePath: BASE.expectedRemotePath,
		tracked,
	};

	it("records an accepted push-mirror deletion without scheduling an upload", async () => {
		const manager = new SyncManager();
		const plan = await manager.planMirrorBatch("push", [candidate], () =>
			Promise.resolve(null),
		);

		expect(plan.uploads).toEqual([]);
		expect(plan.relocations).toEqual([]);
		expect(plan.trackingUpdates[0]).toMatchObject({
			docId: tracked.docId,
			remotePath: null,
		});
		expect(typeof plan.trackingUpdates[0].lastSyncedAt).toBe("string");
	});

	it("does not reread remote metadata when the cached root hash is unchanged", async () => {
		const manager = new SyncManager();
		let remoteReads = 0;
		const plan = await manager.planMirrorBatch(
			"strict",
			[candidate],
			() => {
				remoteReads++;
				return Promise.resolve(BASE.remote);
			},
			{ remoteTreeUnchanged: true },
		);

		expect(remoteReads).toBe(0);
		expect(plan.uploads).toEqual([]);
	});

	it("schedules a strict-mirror deletion for upload", async () => {
		const manager = new SyncManager();
		const plan = await manager.planMirrorBatch("strict", [candidate], () =>
			Promise.resolve(null),
		);
		expect(plan.uploads).toEqual(["plan"]);
	});

	it("migrates a legacy rendered hash without uploading an older source file", async () => {
		const manager = new SyncManager();
		const legacy = { ...tracked, localHash: undefined };
		const plan = await manager.planMirrorBatch(
			"strict",
			[
				{
					...candidate,
					tracked: legacy,
					localHash: "raw-source-hash",
					legacyContentHash: "new-renderer-hash",
					localModifiedAt: Date.parse("2026-09-02T00:00:00Z"),
				},
			],
			() => Promise.resolve(BASE.remote),
		);

		expect(plan.uploads).toEqual([]);
		expect(plan.trackingUpdates[0].localHash).toBe("raw-source-hash");
	});

	it("uploads a legacy mapping when source and rendered output changed after upload", async () => {
		const manager = new SyncManager();
		const plan = await manager.planMirrorBatch(
			"strict",
			[
				{
					...candidate,
					tracked: { ...tracked, localHash: undefined },
					legacyContentHash: "changed-rendered-hash",
					localModifiedAt: Date.parse("2026-09-04T00:00:00Z"),
				},
			],
			() => Promise.resolve(BASE.remote),
		);

		expect(plan.uploads).toEqual(["plan"]);
	});

	it("invalidates reconciliation timestamps without losing content fingerprints", () => {
		const manager = new SyncManager();
		const invalidated = manager.invalidateMirrorCache({
			[tracked.docId]: {
				...tracked,
				lastSyncedAt: "2026-09-03T01:00:00Z",
			},
		});

		expect(invalidated[tracked.docId].lastSyncedAt).toBeUndefined();
		expect(invalidated[tracked.docId].contentHash).toBe(tracked.contentHash);
		expect(invalidated[tracked.docId].remotePath).toBe(tracked.remotePath);
	});

	it("selects only remote documents without a local counterpart", () => {
		const manager = new SyncManager();
		const remote = [
			{ deviceDocId: "keep", remotePath: "Obsidian/Keep" },
			{ deviceDocId: "remove", remotePath: "Obsidian/Remove" },
		];

		expect(
			manager.findExtraneousRemoteDocuments(remote, new Set(["keep"])),
		).toEqual([remote[1]]);
	});

	it("finds a tracked note by local path when frontmatter metadata is unavailable", () => {
		const manager = new SyncManager();
		const table = { [tracked.docId]: tracked };

		expect(manager.findTrackedMapping(table, tracked.notePath)).toBe(tracked);
		expect(
			manager.findTrackedMapping(table, "elsewhere.md", tracked.docId),
		).toBe(tracked);
	});
});
