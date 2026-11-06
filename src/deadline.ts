/**
 * Bound a wait that has no deadline of its own (GP_E5_S27).
 *
 * All cloud work shares one lane (GP_E5_S21), so a single promise that never
 * settles stops every send and import until Obsidian restarts — and on
 * mobile Obsidian can stay in memory for days. `requestUrl` has no timeout,
 * and a WebView callback such as `canvas.toBlob` may simply never fire.
 * This turns such a wait into an error the caller already knows how to
 * report. The abandoned work may still finish later; its result is ignored.
 */

export interface DeadlineTimers {
	setTimer: (fn: () => void, ms: number) => number;
	clearTimer: (id: number) => void;
}

const WINDOW_TIMERS: DeadlineTimers = {
	setTimer: (fn, ms) => window.setTimeout(fn, ms),
	clearTimer: (id) => window.clearTimeout(id),
};

export function withDeadline<T>(
	work: Promise<T>,
	ms: number,
	message: string,
	timers: DeadlineTimers = WINDOW_TIMERS,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = timers.setTimer(() => reject(new Error(message)), ms);
		work.then(
			(value) => {
				timers.clearTimer(timer);
				resolve(value);
			},
			(error: unknown) => {
				timers.clearTimer(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}
