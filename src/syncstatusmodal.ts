import { App, Modal, Setting } from "obsidian";
import type { SyncStatusSummary } from "./sync/statussummary";

export interface SyncStatusView {
	mode: string;
	watchFolder: string;
	summary: SyncStatusSummary;
}

export class SyncStatusModal extends Modal {
	constructor(
		app: App,
		private readonly view: SyncStatusView,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("reMarkable sync status");
		const { summary } = this.view;
		this.row("Queue", summary.queue);
		this.row("Queued work", String(summary.queuedWork));
		this.row("Pending local changes", String(summary.pendingChanges));
		this.row("Pending local removals", String(summary.pendingRemovals));
		this.row("Mirror mode", this.view.mode);
		this.row("Watch folder", this.view.watchFolder);
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
		this.row("Known remote copies", String(summary.knownRemoteCopies));
		this.row(
			"Known missing remote copies",
			String(summary.missingRemoteCopies),
		);
		this.row(
			"Last reconciliation",
			summary.lastSyncedAt === null
				? "Never"
				: new Date(summary.lastSyncedAt).toLocaleString(),
		);
	}

	private row(name: string, value: string): void {
		const setting = new Setting(this.contentEl).setName(name);
		setting.controlEl.setText(value);
	}
}
