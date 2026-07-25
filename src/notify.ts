/**
 * All user-facing messages carry the plugin name (GP_E3_S4).
 *
 * A beta tester could not tell whether a toast came from this plugin, from
 * Obsidian, or from the reMarkable app — they all look alike on mobile.
 * Prefixing removes that guesswork, which matters most exactly when
 * something goes wrong.
 */

import { Notice } from "obsidian";

export const NOTICE_PREFIX = "reMarkable Round-Trip";

export function notify(message: string, timeoutMs?: number): Notice {
	return new Notice(`${NOTICE_PREFIX} — ${message}`, timeoutMs);
}

/** A Notice that stays up and whose text is updated while work progresses. */
export function progressNotice(message: string): Notice {
	return new Notice(`${NOTICE_PREFIX} — ${message}`, 0);
}

export function updateProgress(notice: Notice, message: string): void {
	notice.setMessage(`${NOTICE_PREFIX} — ${message}`);
}
