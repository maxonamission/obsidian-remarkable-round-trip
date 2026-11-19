import { App, Modal, Setting } from "obsidian";
import type { SyncStatusSummary } from "./sync/statussummary";

export interface SyncStatusView {
	mode: string;
	watchFolder: string;
	summary: SyncStatusSummary;
	/** Replace a stuck queue with a fresh one (GP_E5_S27). */
	onReset?: () => void;
}

/** How often the open window redraws (GP_E5_S31). */
const REFRESH_MS = 1000;

export class SyncStatusModal extends Modal {
	private timer: number | null = null;

	/**
	 * `view` is asked again on every redraw, so the window follows a running
	 * send instead of freezing the moment it was opened (GP_E5_S31).
	 */
	constructor(
		app: App,
		private readonly view: () => SyncStatusView,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("reMarkable sync status");
		this.render();
		this.timer = window.setInterval(() => this.render(), REFRESH_MS);
	}

	onClose(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		const view = this.view();
		const { summary } = view;
		this.row("Now", summary.now);
		this.row("Queue", summary.queue);
		this.row("Queued work", String(summary.queuedWork));
		this.row("Pending local changes", String(summary.pendingChanges));
		this.row("Folder mirroring", view.mode);
		this.row("Watch folder", view.watchFolder);
		this.row("Notes in watch folder", String(summary.watchNotes));
		this.row("Watch notes not yet synced", String(summary.untrackedWatchNotes));
		this.row("Tracked notes", String(summary.trackedNotes));
		this.row(
			"Tracked notes present locally",
			String(summary.localTrackedNotes),
		);
		this.row(
			"Tracked notes missing locally",
			String(summary.missingLocalNotes),
		);
		this.row(
			"Last upload",
			summary.lastUploadedAt === null
				? "Never"
				: new Date(summary.lastUploadedAt).toLocaleString(),
		);
		const onReset = view.onReset;
		if (summary.canReset && onReset !== undefined) {
			// Knowing is automatic; acting is the user's call. The queue is never
			// reset behind their back, because the task it lets go of may still
			// be running.
			new Setting(this.contentEl)
				.setName("Reset sync queue")
				.setDesc(
					"Cancels queued work and stops waiting for the running task. " +
						"Use this when nothing has moved for a while; then run your " +
						"send or import again.",
				)
				.addButton((button) =>
					button
						.setButtonText("Reset")
						.setDestructive()
						.onClick(() => {
							this.close();
							onReset();
						}),
				);
		}
	}

	private row(name: string, value: string): void {
		const setting = new Setting(this.contentEl).setName(name);
		setting.controlEl.setText(value);
	}
}
