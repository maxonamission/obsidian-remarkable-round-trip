/** Counted progress, passed as data so the bar never parses UI text. */
export interface ProgressCount {
	done: number;
	total: number;
}

/** Bounded 0–100, or null when there is nothing to count (indeterminate). */
export function progressPercent(
	count: ProgressCount | undefined,
): number | null {
	if (count === undefined) return null;
	const { done, total } = count;
	if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0)
		return null;
	return Math.max(0, Math.min(100, (done / total) * 100));
}
