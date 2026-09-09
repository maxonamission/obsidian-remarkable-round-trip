/**
 * All user-facing messages carry the plugin name (GP_E3_S4).
 *
 * A beta tester could not tell whether a toast came from this plugin, from
 * Obsidian, or from the reMarkable app — they all look alike on mobile.
 * Prefixing removes that guesswork, which matters most exactly when
 * something goes wrong.
 */

import { Notice, ProgressBarComponent, setIcon, setTooltip } from "obsidian";
import { progressPercent } from "./status";

export const NOTICE_PREFIX = "reMarkable Round-Trip";

export function notify(message: string, timeoutMs?: number): Notice {
	return new Notice(`${NOTICE_PREFIX} — ${message}`, timeoutMs);
}

export interface ProgressHandle {
	setMessage(message: string): void;
	hide(): void;
}

/** Mobile fallback: Obsidian does not expose its status bar there. */
export function progressNotice(message: string): ProgressHandle {
	const notice = new Notice(`${NOTICE_PREFIX} — ${message}`, 0);
	return {
		setMessage: (next) => notice.setMessage(`${NOTICE_PREFIX} — ${next}`),
		hide: () => notice.hide(),
	};
}

export function updateProgress(
	progress: ProgressHandle,
	message: string,
): void {
	progress.setMessage(message);
}

/** One reusable desktop status-bar item; stale handles cannot hide newer work. */
export class ProgressStatus {
	private readonly icon: HTMLElement;
	private readonly barContainer: HTMLElement;
	private readonly bar: ProgressBarComponent;
	private readonly text: HTMLElement;
	private activeToken = 0;

	constructor(private readonly item: HTMLElement) {
		item.addClass("remarkable-round-trip-status");
		this.icon = item.createSpan({ cls: "remarkable-round-trip-status-icon" });
		setIcon(this.icon, "refresh-cw");
		this.barContainer = item.createSpan({
			cls: "remarkable-round-trip-status-progress",
		});
		this.bar = new ProgressBarComponent(this.barContainer);
		this.text = item.createSpan({ cls: "remarkable-round-trip-status-text" });
		item.hide();
	}

	begin(message: string): ProgressHandle {
		const token = ++this.activeToken;
		this.render(message);
		this.item.show();
		return {
			setMessage: (next) => {
				if (token === this.activeToken) this.render(next);
			},
			hide: () => {
				if (token === this.activeToken) this.item.hide();
			},
		};
	}

	private render(message: string): void {
		const percent = progressPercent(message);
		this.item.toggleClass("is-indeterminate", percent === null);
		if (percent === null) this.barContainer.hide();
		else {
			this.bar.setValue(percent);
			this.barContainer.show();
		}
		this.text.setText(message);
		setTooltip(this.item, `${NOTICE_PREFIX} — ${message}`);
	}
}
