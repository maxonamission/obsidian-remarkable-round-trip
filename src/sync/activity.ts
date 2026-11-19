/**
 * What the plugin is doing right now, for the sync-status window (GP_E5_S31).
 *
 * Progress already reaches the user through one handle per operation — the
 * status bar on desktop, an updating notice on mobile. The status window
 * could not see it, so it showed a snapshot that said nothing about where a
 * send was. Tracking a handle here keeps one source of truth: whatever the
 * bar or notice says, the window says too.
 *
 * The newest operation wins, like the status bar itself: a handle from an
 * earlier operation can no longer change or clear what is shown.
 */

import type { ProgressHandle } from "../notify";
import type { ProgressCount } from "../status";

export interface ActivitySnapshot {
	message: string;
	count?: ProgressCount;
	/** When this operation started (ms since epoch). */
	since: number;
}

export class SyncActivity {
	private current: ActivitySnapshot | null = null;
	private token = 0;

	constructor(private readonly now: () => number = Date.now) {}

	/** Wrap `handle` so every message it shows is also recorded here. */
	track(handle: ProgressHandle, message: string, count?: ProgressCount): ProgressHandle {
		const token = ++this.token;
		const since = this.now();
		this.current = { message, count, since };
		return {
			setMessage: (next, nextCount) => {
				handle.setMessage(next, nextCount);
				if (token === this.token) this.current = { message: next, count: nextCount, since };
			},
			hide: () => {
				handle.hide();
				if (token === this.token) this.current = null;
			},
		};
	}

	snapshot(): ActivitySnapshot | null {
		return this.current;
	}
}
