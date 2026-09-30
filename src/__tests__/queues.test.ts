import { describe, expect, it } from "vitest";
import { PullQueue, PushQueue, SyncQueueCoordinator } from "../sync/queues";

describe("SyncQueueCoordinator", () => {
	it("runs folder creation, then file pushes, then pulls", async () => {
		const coordinator = new SyncQueueCoordinator();
		const order: string[] = [];
		const pull = coordinator.enqueue(
			"pull",
			async () => void order.push("pull"),
		);
		const push = coordinator.enqueue(
			"push",
			async () => void order.push("push"),
		);
		const folder = coordinator.enqueue(
			"folder",
			async () => void order.push("folder"),
		);

		await Promise.all([pull, push, folder]);
		expect(order).toEqual(["folder", "push", "pull"]);
	});

	it("moves a newly queued folder create ahead of a pending file push", async () => {
		const coordinator = new SyncQueueCoordinator();
		const order: string[] = [];
		let release: (() => void) | undefined;
		const active = coordinator.enqueue(
			"folder",
			() =>
				new Promise<void>((resolve) => {
					order.push("active-folder");
					release = resolve;
				}),
		);
		const file = coordinator.enqueue(
			"push",
			async () => void order.push("pending-file"),
		);
		await Promise.resolve();
		expect(coordinator.status()).toEqual({
			active: "folder",
			queuedFolders: 0,
			queuedPushes: 1,
			queuedPulls: 0,
		});
		const folder = coordinator.enqueue(
			"folder",
			async () => void order.push("new-folder"),
		);

		release?.();
		await Promise.all([active, file, folder]);
		expect(order).toEqual(["active-folder", "new-folder", "pending-file"]);
		expect(coordinator.status()).toEqual({
			active: null,
			queuedFolders: 0,
			queuedPushes: 0,
			queuedPulls: 0,
		});
	});

	it("never overlaps cloud work and continues after a failure", async () => {
		const coordinator = new SyncQueueCoordinator();
		let active = 0;
		let maxActive = 0;
		const run = async (fail = false) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await Promise.resolve();
			active--;
			if (fail) throw new Error("failed");
		};

		const failed = coordinator.enqueue("folder", () => run(true));
		const next = coordinator.enqueue("push", () => run());
		await expect(failed).rejects.toThrow("failed");
		await next;
		expect(maxActive).toBe(1);
	});

	it("lets a pull yield to pending push work at a document boundary", async () => {
		const coordinator = new SyncQueueCoordinator();
		const pushQueue = new PushQueue(coordinator);
		const order: string[] = [];
		let pushed: Promise<void> | undefined;

		await coordinator.enqueue("pull", async () => {
			order.push("pull-document-1");
			pushed = pushQueue.enqueue({
				ensureFolders: async () => void order.push("folders"),
				uploadFiles: async () => void order.push("files"),
			});
			await coordinator.yieldToPush();
			order.push("pull-document-2");
		});
		await pushed;

		expect(order).toEqual([
			"pull-document-1",
			"folders",
			"files",
			"pull-document-2",
		]);
	});

	it("rejects pending and future work when disposed", async () => {
		const coordinator = new SyncQueueCoordinator();
		let release: (() => void) | undefined;
		const active = coordinator.enqueue(
			"folder",
			() => new Promise<void>((resolve) => (release = resolve)),
		);
		const pending = coordinator.enqueue("push", () => Promise.resolve());
		await Promise.resolve();

		coordinator.dispose();
		await expect(pending).rejects.toThrow("shut down");
		release?.();
		await active;
		await expect(
			coordinator.enqueue("pull", () => Promise.resolve()),
		).rejects.toThrow("shut down");
	});
});

describe("PushQueue", () => {
	it("creates folders and uploads files as two ordered entries", async () => {
		const coordinator = new SyncQueueCoordinator();
		const queue = new PushQueue(coordinator);
		const order: string[] = [];

		await queue.enqueue({
			ensureFolders: async () => void order.push("folders"),
			uploadFiles: async () => void order.push("files"),
		});
		expect(order).toEqual(["folders", "files"]);
	});

	it("does not upload files when folder preparation fails", async () => {
		const coordinator = new SyncQueueCoordinator();
		const queue = new PushQueue(coordinator);
		let uploaded = false;

		await expect(
			queue.enqueue({
				ensureFolders: () => Promise.reject(new Error("rate limited")),
				uploadFiles: async () => {
					uploaded = true;
				},
			}),
		).rejects.toThrow("rate limited");
		expect(uploaded).toBe(false);
	});
});

describe("PullQueue", () => {
	it("deduplicates equivalent pending pulls", async () => {
		const coordinator = new SyncQueueCoordinator();
		const queue = new PullQueue(coordinator);
		let calls = 0;
		const run = async () => {
			calls++;
		};

		const first = queue.enqueue("annotations:all", run);
		const duplicate = queue.enqueue("annotations:all", run);
		expect(duplicate).toBe(first);
		await Promise.all([first, duplicate]);
		expect(calls).toBe(1);
	});
});
