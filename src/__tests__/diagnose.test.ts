import { describe, expect, it } from "vitest";
import { MappingTable } from "../id/mapping";
import { DiagnoseApi, describeDiagnosis, diagnoseCloud } from "../transport/diagnose";

const TABLE: MappingTable = {
	a: {
		docId: "a",
		notePath: "a.md",
		deviceDocId: "device-a",
		uploadedAt: "2026-07-25T10:00:00Z",
		contentHash: "h",
	},
	b: {
		docId: "b",
		notePath: "b.md",
		deviceDocId: "device-weg",
		uploadedAt: "2026-07-25T10:00:00Z",
		contentHash: "h",
	},
};

const api: DiagnoseApi = {
	getRootHash: () => Promise.resolve(["roothash", 42, 4]),
	listItems: () =>
		Promise.resolve([
			{ id: "device-a", type: "DocumentType" },
			{ id: "device-c", type: "DocumentType" },
			{ id: "dir-1", type: "CollectionType" },
		]),
};

describe("diagnoseCloud", () => {
	it("reports the account state and which sent notes are still there", async () => {
		expect(await diagnoseCloud(api, TABLE)).toEqual({
			reachable: true,
			generation: 42,
			schemaVersion: 4,
			documentCount: 2,
			folderCount: 1,
			mappedPresent: 1,
			mappedMissing: 1,
		});
	});

	it("never throws: an unreachable account is a result, not a crash", async () => {
		const broken: DiagnoseApi = {
			getRootHash: () => Promise.reject(new Error("geen verbinding")),
			listItems: () => Promise.resolve([]),
		};
		expect(await diagnoseCloud(broken, TABLE)).toEqual({
			reachable: false,
			error: "geen verbinding",
		});
	});

	it("works with an empty mapping table", async () => {
		const result = await diagnoseCloud(api, {});
		expect(result).toMatchObject({ reachable: true, mappedPresent: 0, mappedMissing: 0 });
	});
});

describe("describeDiagnosis", () => {
	it("points at the device when the cloud reads fine", async () => {
		const text = describeDiagnosis(await diagnoseCloud(api, TABLE));
		expect(text).toContain("2 documents");
		expect(text).toContain("generation 42");
		expect(text).toContain("local to");
	});

	it("points at connection or pairing when the cloud cannot be read", () => {
		const text = describeDiagnosis({ reachable: false, error: "401" });
		expect(text).toContain("not at the tablet");
	});
});
