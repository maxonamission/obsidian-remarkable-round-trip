/**
 * Watch-folder queue (PRD F6): notes created/modified inside the configured
 * vault folder are debounced per file and then handed to the send flow —
 * without a manual command. Timers are injected so the logic tests without
 * a DOM and the plugin edge can pass window-bound timers.
 */

export interface WatchQueueOptions {
	/** Vault folder to watch, without trailing slash (e.g. "reMarkable-out"). */
	folder: string;
	/** Quiet period after the last change before a file is sent. */
	debounceMs: number;
	setTimer: (fn: () => void, ms: number) => number;
	clearTimer: (id: number) => void;
	/** Called once per file when its debounce window closes. */
	onReady: (path: string) => void;
}

/** True when the path lives inside the watched folder (any depth). */
export function isInWatchFolder(path: string, folder: string): boolean {
	const prefix = folder.replace(/\/+$/, "");
	if (prefix === "") return false;
	return path === prefix || path.startsWith(`${prefix}/`);
}

export class WatchQueue {
	private readonly pending = new Map<string, number>();

	constructor(private readonly opts: WatchQueueOptions) {}

	/** Report a create/modify event; only markdown files in the folder count. */
	noteChanged(path: string): void {
		if (!path.endsWith(".md")) return;
		if (!isInWatchFolder(path, this.opts.folder)) return;
		const existing = this.pending.get(path);
		if (existing !== undefined) this.opts.clearTimer(existing);
		const id = this.opts.setTimer(() => {
			this.pending.delete(path);
			this.opts.onReady(path);
		}, this.opts.debounceMs);
		this.pending.set(path, id);
	}

	/** A rename/delete out of the folder cancels the pending send. */
	noteRemoved(path: string): void {
		const existing = this.pending.get(path);
		if (existing !== undefined) {
			this.opts.clearTimer(existing);
			this.pending.delete(path);
		}
	}

	/** Cancel everything (plugin unload or settings change). */
	dispose(): void {
		for (const id of this.pending.values()) this.opts.clearTimer(id);
		this.pending.clear();
	}
}
