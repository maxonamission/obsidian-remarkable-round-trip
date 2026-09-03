/**
 * Watch-folder queue (PRD F6): notes created/modified inside the configured
 * vault folder are collected into one debounced batch and handed to the send
 * flow without a manual command. Timers are injected so the logic tests
 * without a DOM and the plugin edge can pass window-bound timers.
 */

export interface WatchQueueOptions {
	/** Vault folder to watch, without trailing slash (e.g. "reMarkable-out"). */
	folder: string;
	/** Quiet period after the last change before a file is sent. */
	debounceMs: number;
	setTimer: (fn: () => void, ms: number) => number;
	clearTimer: (id: number) => void;
	/** Called once with the deduplicated batch when the quiet window closes. */
	onReady: (paths: string[]) => void;
}

/** True when the path lives inside the watched folder (any depth). */
export function isInWatchFolder(path: string, folder: string): boolean {
	const prefix = folder.replace(/\/+$/, "");
	if (prefix === "") return false;
	return path === prefix || path.startsWith(`${prefix}/`);
}

export class WatchQueue {
	private readonly pending = new Set<string>();
	private timer: number | null = null;

	constructor(private readonly opts: WatchQueueOptions) {}

	/** Report a create/modify event; only markdown files in the folder count. */
	noteChanged(path: string): void {
		if (!path.endsWith(".md")) return;
		if (!isInWatchFolder(path, this.opts.folder)) return;
		this.pending.add(path);
		if (this.timer !== null) this.opts.clearTimer(this.timer);
		this.timer = this.opts.setTimer(() => {
			this.timer = null;
			const paths = [...this.pending];
			this.pending.clear();
			this.opts.onReady(paths);
		}, this.opts.debounceMs);
	}

	/** A rename/delete out of the folder cancels the pending send. */
	noteRemoved(path: string): void {
		this.pending.delete(path);
		if (this.pending.size === 0 && this.timer !== null) {
			this.opts.clearTimer(this.timer);
			this.timer = null;
		}
	}

	/** Cancel everything (plugin unload or settings change). */
	dispose(): void {
		if (this.timer !== null) this.opts.clearTimer(this.timer);
		this.timer = null;
		this.pending.clear();
	}
}
