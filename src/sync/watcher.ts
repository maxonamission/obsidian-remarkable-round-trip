/**
 * Watch-folder queue (PRD F6): notes created/modified inside the configured
 * vault folder are collected into one debounced batch and handed to the send
 * flow without a manual command. Timers are injected so the logic tests
 * without a DOM and the plugin edge can pass window-bound timers.
 */

export interface WatchQueueOptions {
	/** Vault folder to watch, without trailing slash (e.g. "reMarkable-out"). */
	folder: string;
	/** Previously synced notes remain tracked even outside the watch folder. */
	isTracked?: (path: string) => boolean;
	/** Quiet period after the last change before a file is sent. */
	debounceMs: number;
	setTimer: (fn: () => void, ms: number) => number;
	clearTimer: (id: number) => void;
	/** Called once with the deduplicated batch when the quiet window closes. */
	onReady: (batch: WatchBatch) => void;
}

export interface WatchBatch {
	changed: string[];
	removed: string[];
}

/** True when the path lives inside the watched folder (any depth). */
export function isInWatchFolder(path: string, folder: string): boolean {
	const prefix = folder.replace(/\/+$/, "");
	if (prefix === "") return false;
	return path === prefix || path.startsWith(`${prefix}/`);
}

export class WatchQueue {
	private readonly changed = new Set<string>();
	private readonly removed = new Set<string>();
	private timer: number | null = null;

	constructor(private readonly opts: WatchQueueOptions) {}

	/** Report a create/modify event; only markdown files in the folder count. */
	noteChanged(path: string): void {
		this.notesChanged([path]);
	}

	notesChanged(paths: string[]): void {
		let added = false;
		for (const path of paths) {
			if (!path.endsWith(".md")) continue;
			if (!this.isWatched(path)) continue;
			this.removed.delete(path);
			this.changed.add(path);
			added = true;
		}
		if (added) this.restartTimer();
	}

	private addChanged(path: string): void {
		if (!path.endsWith(".md")) return;
		this.removed.delete(path);
		this.changed.add(path);
	}

	noteRenamed(oldPath: string, newPath: string): void {
		const oldTracked = this.opts.isTracked?.(oldPath) === true;
		const oldWatched = oldPath.endsWith(".md") && this.isWatched(oldPath);
		const newWatched = newPath.endsWith(".md") && this.isWatched(newPath);
		this.changed.delete(oldPath);
		this.removed.delete(oldPath);
		if (
			(oldTracked && !newPath.endsWith(".md")) ||
			(oldWatched && !newWatched && !oldTracked)
		) {
			this.removed.add(oldPath);
		}
		if (newWatched || (oldTracked && newPath.endsWith(".md"))) {
			this.addChanged(newPath);
		}
		if (oldWatched || newWatched) this.restartTimer();
	}

	/** A local deletion is part of the mirrored change set. */
	noteRemoved(path: string): void {
		if (!path.endsWith(".md")) return;
		if (!this.isWatched(path)) return;
		this.changed.delete(path);
		this.removed.add(path);
		this.restartTimer();
	}

	notesRemoved(paths: string[]): void {
		let added = false;
		for (const path of paths) {
			if (!path.endsWith(".md")) continue;
			this.changed.delete(path);
			this.removed.add(path);
			added = true;
		}
		if (added) this.restartTimer();
	}

	status(): { pendingChanges: number; pendingRemovals: number } {
		return {
			pendingChanges: this.changed.size,
			pendingRemovals: this.removed.size,
		};
	}

	private isWatched(path: string): boolean {
		return (
			isInWatchFolder(path, this.opts.folder) ||
			this.opts.isTracked?.(path) === true
		);
	}

	private restartTimer(): void {
		if (this.timer !== null) this.opts.clearTimer(this.timer);
		this.timer = this.opts.setTimer(() => {
			this.timer = null;
			const batch = { changed: [...this.changed], removed: [...this.removed] };
			this.changed.clear();
			this.removed.clear();
			this.opts.onReady(batch);
		}, this.opts.debounceMs);
	}

	/** Cancel everything (plugin unload or settings change). */
	dispose(): void {
		if (this.timer !== null) this.opts.clearTimer(this.timer);
		this.timer = null;
		this.changed.clear();
		this.removed.clear();
	}
}
