import { describe, expect, it } from "vitest";
import { progressPercent } from "../status";

describe("progressPercent", () => {
	it("extracts bounded progress from status text", () => {
		expect(progressPercent("Sending 25/100 to reMarkable…")).toBe(25);
		expect(progressPercent("Uploading changed or missing notes 3/12…")).toBe(
			25,
		);
		expect(progressPercent("Checking 6/3 for annotations…")).toBe(100);
	});

	it("leaves non-counting work indeterminate", () => {
		expect(
			progressPercent("Reading your reMarkable cloud account…"),
		).toBeNull();
		expect(progressPercent("Sending 0/0 to reMarkable…")).toBeNull();
	});
});
