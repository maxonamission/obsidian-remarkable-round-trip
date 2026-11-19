import { describe, expect, it } from "vitest";
import { parseDeviceIndex } from "../transport/deviceindex";
import { settingsFrom } from "../settingsmodel";

// GP_E5_S24: the index lives in data.json, which can be hand-edited, synced
// from another version or damaged. Anything malformed only costs a re-read.
describe("parseDeviceIndex", () => {
	it("keeps a well-formed index", () => {
		const index = {
			nonFolders: ["a", "b"],
			folders: {
				base: { hash: "h1", visibleName: "Obsidian", parent: "", createdTime: "17" },
			},
		};
		expect(parseDeviceIndex(index)).toEqual(index);
	});

	it("drops malformed parts and keeps the rest", () => {
		expect(
			parseDeviceIndex({
				nonFolders: ["a", 3, null, "a"],
				folders: {
					good: { hash: "h", visibleName: "Map", parent: "" },
					noHash: { visibleName: "Map", parent: "" },
					wrong: "folder",
					extra: { hash: "h", visibleName: "X", parent: "", lastModified: 5, note: "x" },
				},
			}),
		).toEqual({
			nonFolders: ["a"],
			folders: {
				good: { hash: "h", visibleName: "Map", parent: "" },
				extra: { hash: "h", visibleName: "X", parent: "" },
			},
		});
	});

	it("starts empty from nothing or nonsense", () => {
		for (const value of [undefined, null, "index", 42, []]) {
			expect(parseDeviceIndex(value)).toEqual({ nonFolders: [], folders: {} });
		}
	});

	it("treats a __proto__ key as an ordinary entry, not a prototype change", () => {
		const stored = JSON.parse(
			'{"folders":{"__proto__":{"hash":"h","visibleName":"X","parent":""}}}',
		) as unknown;
		const index = parseDeviceIndex(stored);
		expect(Object.getPrototypeOf(index.folders)).toBe(Object.prototype);
		expect(Object.keys(index.folders)).toEqual(["__proto__"]);
	});

	it("is applied when settings load", () => {
		const settings = settingsFrom({
			deviceIndex: { nonFolders: "kapot", folders: null } as never,
		});
		expect(settings.deviceIndex).toEqual({ nonFolders: [], folders: {} });
		expect(settingsFrom({}).deviceIndex).toEqual({ nonFolders: [], folders: {} });
	});
});
