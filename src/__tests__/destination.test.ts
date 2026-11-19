import { describe, expect, it } from "vitest";
import { describeSent } from "../sync/destination";

// GP_E5_S31: a success message names where the note went, so a note that
// landed in the wrong folder (GP_E5_S30) shows at once.
describe("describeSent", () => {
	it("names the folder of a single note, without the .md", () => {
		expect(describeSent([{ name: "Weeklog.md", folder: "Obsidian/Projecten" }])).toBe(
			'Sent "Weeklog" to Obsidian/Projecten on your reMarkable.',
		);
	});

	it("says top level when there is no folder", () => {
		expect(describeSent([{ name: "Nota.md", folder: "" }])).toBe(
			'Sent "Nota" to the top level of your reMarkable.',
		);
	});

	it("names the one folder a batch went into", () => {
		expect(
			describeSent([
				{ name: "a.md", folder: "Obsidian" },
				{ name: "b.md", folder: "Obsidian" },
			]),
		).toBe("Sent 2 notes to Obsidian on your reMarkable.");
	});

	it("names the shared parent when a batch spread over folders", () => {
		expect(
			describeSent([
				{ name: "a.md", folder: "Obsidian/Projecten/Alpha" },
				{ name: "b.md", folder: "Obsidian/Projecten/Beta" },
				{ name: "c.md", folder: "Obsidian/Projecten" },
			]),
		).toBe("Sent 3 notes to 3 folders under Obsidian/Projecten on your reMarkable.");
	});

	it("counts folders when they share nothing", () => {
		expect(
			describeSent([
				{ name: "a.md", folder: "Alpha" },
				{ name: "b.md", folder: "" },
			]),
		).toBe("Sent 2 notes to 2 folders on your reMarkable.");
	});

	it("does not mistake a shared name prefix for a shared folder", () => {
		expect(
			describeSent([
				{ name: "a.md", folder: "Obsidian/Pro" },
				{ name: "b.md", folder: "Obsidian/Projecten" },
			]),
		).toBe("Sent 2 notes to 2 folders under Obsidian on your reMarkable.");
	});
});
