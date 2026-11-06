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
	/**
	 * When the running task started (ms since epoch), so a user can tell a
	 * slow task from a stuck one (GP_E5_S27). Null when nothing runs.
	 */
	activeSince: number | null;
	queuedFolders: number;
	queuedPushes: number;
	queuedPulls: number;
}

export const QUEUE_SHUT_DOWN = "Sync queue was shut down.";
export const QUEUE_RESET =
	"Sync queue was reset; this task was cancelled. Run it again when you are ready.";

/**
 * True for the rejection a disposed lane hands its waiting work — a
 * cancellation, not a failure. Anything else is a real error and must stay
 * visible (GP_E5_S27).
 */
export function isQueueCancellation(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message === QUEUE_SHUT_DOWN || message === QUEUE_RESET;
}

export class SyncQueueCoordinator {
	private readonly folders: QueueEntry<unknown>[] = [];
	private readonly pushes: QueueEntry<unknown>[] = [];
	private readonly pulls: QueueEntry<unknown>[] = [];
	private draining = false;
	private disposed = false;
	private disposeReason = QUEUE_SHUT_DOWN;
	private active: SyncWorkKind | null = null;
	private activeSince: number | null = null;

	constructor(private readonly now: () => number = Date.now) {}

	enqueue<T>(kind: SyncWorkKind, run: () => Promise<T>): Promise<T> {
		if (this.disposed) {
			return Promise.reject(new Error(this.disposeReason));
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
			activeSince: this.activeSince,
			queuedFolders: this.folders.length,
			queuedPushes: this.pushes.length,
			queuedPulls: this.pulls.length,
		};
	}

	/**
	 * Reject everything still waiting and accept nothing new. The task that is
	 * running is not interrupted — a promise cannot be cancelled — but this
	 * lane no longer waits for it: the owner replaces a disposed lane with a
	 * fresh one (GP_E5_S27).
	 */
	dispose(reason: string = QUEUE_SHUT_DOWN): void {
		this.disposed = true;
		this.disposeReason = reason;
		const error = new Error(reason);
		for (const queue of [this.folders, this.pushes, this.pulls]) {
			for (const entry of queue.splice(0)) entry.reject(error);
		}
	}

	/**
	 * A long pull calls this between documents. Pending pushes run at that safe
	 * boundary without interrupting the cloud request currently in flight.
	 * A pull from a disposed lane finds nothing here: it was let go of, and
	 * must not run work beside the lane that replaced it (GP_E5_S27).
	 */
	async yieldToPush(): Promise<void> {
		if (this.disposed) return;
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
		// A push run from inside a pull (yieldToPush) nests; restore both.
		const previous = this.active;
		const previousSince = this.activeSince;
		this.active = entry.kind;
		this.activeSince = this.now();
		try {
			entry.resolve(await entry.run());
		} catch (error) {
			entry.reject(error);
		} finally {
			this.active = previous;
			this.activeSince = previousSince;
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
