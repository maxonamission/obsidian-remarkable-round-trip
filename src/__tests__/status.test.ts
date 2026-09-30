import { describe, expect, it } from "vitest";
import { progressPercent } from "../status";

describe("progressPercent", () => {
	it("computes bounded progress from counts", () => {
		expect(progressPercent({ done: 25, total: 100 })).toBe(25);
		expect(progressPercent({ done: 3, total: 12 })).toBe(25);
		expect(progressPercent({ done: 6, total: 3 })).toBe(100);
		expect(progressPercent({ done: -1, total: 3 })).toBe(0);
	});

	it("leaves non-counting work indeterminate", () => {
		expect(progressPercent(undefined)).toBeNull();
		expect(progressPercent({ done: 0, total: 0 })).toBeNull();
		expect(progressPercent({ done: 1, total: Number.NaN })).toBeNull();
	});
});
