export function progressPercent(message: string): number | null {
	const match = /\b(\d+)\s*\/\s*(\d+)\b/.exec(message);
	if (match === null) return null;
	const done = Number(match[1]);
	const total = Number(match[2]);
	if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0)
		return null;
	return Math.max(0, Math.min(100, (done / total) * 100));
}
