import { describe, expect, it } from "vitest";
import { shouldAnnounceUpdate } from "../updatenotice";

describe("shouldAnnounceUpdate (GP_E5_S3)", () => {
	it("announces a minor step forward", () => {
		expect(shouldAnnounceUpdate("0.27.1", "0.28.0")).toBe(true);
	});

	it("announces a major step forward", () => {
		expect(shouldAnnounceUpdate("0.28.0", "1.0.0")).toBe(true);
	});

	it("announces a minor jump spanning several releases", () => {
		expect(shouldAnnounceUpdate("0.25.2", "0.28.1")).toBe(true);
	});

	it("stays silent on a patch bump", () => {
		expect(shouldAnnounceUpdate("0.28.0", "0.28.1")).toBe(false);
	});

	it("stays silent on an equal version", () => {
		expect(shouldAnnounceUpdate("0.28.0", "0.28.0")).toBe(false);
	});

	it("stays silent on a downgrade", () => {
		expect(shouldAnnounceUpdate("1.0.0", "0.28.0")).toBe(false);
		expect(shouldAnnounceUpdate("0.28.0", "0.27.9")).toBe(false);
	});

	it("stays silent on a fresh install (no stored version)", () => {
		expect(shouldAnnounceUpdate("", "0.28.0")).toBe(false);
	});

	it("stays silent on unparseable versions", () => {
		expect(shouldAnnounceUpdate("kapot", "0.28.0")).toBe(false);
		expect(shouldAnnounceUpdate("0.27.1", "kapot")).toBe(false);
	});

	it("tolerates a prerelease suffix", () => {
		expect(shouldAnnounceUpdate("0.27.1", "0.28.0-beta.1")).toBe(true);
		expect(shouldAnnounceUpdate("0.28.0-beta.1", "0.28.1")).toBe(false);
	});
});
