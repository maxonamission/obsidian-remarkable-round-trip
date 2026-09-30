/**
 * One cloud lane shared by outgoing and incoming synchronization.
 * Folder writes outrank document writes, and every write outranks reads.
 */

export type SyncWorkKind = "folder" | "push" | "pull";

interface QueueEntry<T> {
	kind: SyncWorkKind;
	run: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

export interface SyncQueueStatus {
	active: SyncWorkKind | null;
	queuedFolders: number;
	queuedPushes: number;
	queuedPulls: number;
}

export class SyncQueueCoordinator {
	private readonly folders: QueueEntry<unknown>[] = [];
	private readonly pushes: QueueEntry<unknown>[] = [];
	private readonly pulls: QueueEntry<unknown>[] = [];
	private draining = false;
	private disposed = false;
	private active: SyncWorkKind | null = null;

	enqueue<T>(kind: SyncWorkKind, run: () => Promise<T>): Promise<T> {
		if (this.disposed) {
			return Promise.reject(new Error("Sync queue was shut down."));
		}
		const promise = new Promise<T>((resolve, reject) => {
			this.queue(kind).push({
				kind,
				run,
				resolve,
				reject,
			} as QueueEntry<unknown>);
		});
		this.schedule();
		return promise;
	}

	status(): SyncQueueStatus {
		return {
			active: this.active,
			queuedFolders: this.folders.length,
			queuedPushes: this.pushes.length,
			queuedPulls: this.pulls.length,
		};
	}

	dispose(): void {
		this.disposed = true;
		const error = new Error("Sync queue was shut down.");
		for (const queue of [this.folders, this.pushes, this.pulls]) {
			for (const entry of queue.splice(0)) entry.reject(error);
		}
	}

	/**
	 * A long pull calls this between documents. Pending pushes run at that safe
	 * boundary without interrupting the cloud request currently in flight.
	 */
	async yieldToPush(): Promise<void> {
		let entry = this.nextPush();
		while (entry !== undefined) {
			await this.runEntry(entry);
			entry = this.nextPush();
		}
	}

	private queue(kind: SyncWorkKind): QueueEntry<unknown>[] {
		if (kind === "folder") return this.folders;
		if (kind === "push") return this.pushes;
		return this.pulls;
	}

	private schedule(): void {
		if (this.draining) return;
		this.draining = true;
		void Promise.resolve().then(() => this.drain());
	}

	private nextPush(): QueueEntry<unknown> | undefined {
		return this.folders.shift() ?? this.pushes.shift();
	}

	private next(): QueueEntry<unknown> | undefined {
		return this.nextPush() ?? this.pulls.shift();
	}

	private async runEntry(entry: QueueEntry<unknown>): Promise<void> {
		const previous = this.active;
		this.active = entry.kind;
		try {
			entry.resolve(await entry.run());
		} catch (error) {
			entry.reject(error);
		} finally {
			this.active = previous;
		}
	}

	private async drain(): Promise<void> {
		let entry = this.next();
		while (entry !== undefined) {
			await this.runEntry(entry);
			entry = this.next();
		}
		this.draining = false;
	}
}

export interface PushWork {
	ensureFolders: () => Promise<void>;
	uploadFiles: () => Promise<void>;
}

/** A push is always represented by two ordered coordinator entries. */
export class PushQueue {
	constructor(private readonly coordinator: SyncQueueCoordinator) {}

	enqueue(work: PushWork): Promise<void> {
		const preparation = this.coordinator
			.enqueue("folder", work.ensureFolders)
			.then(
				() => ({ ok: true as const }),
				(error: unknown) => ({ ok: false as const, error }),
			);
		return this.coordinator.enqueue("push", async () => {
			const prepared = await preparation;
			if (!prepared.ok) throw prepared.error;
			await work.uploadFiles();
		});
	}
}

/** FIFO pull queue with key-based deduplication. */
export class PullQueue {
	private readonly pending = new Map<string, Promise<void>>();

	constructor(private readonly coordinator: SyncQueueCoordinator) {}

	enqueue(key: string, run: () => Promise<void>): Promise<void> {
		const existing = this.pending.get(key);
		if (existing !== undefined) return existing;

		const queued = this.coordinator.enqueue("pull", run);
		const tracked = queued.finally(() => {
			if (this.pending.get(key) === tracked) this.pending.delete(key);
		});
		this.pending.set(key, tracked);
		return tracked;
	}
}
