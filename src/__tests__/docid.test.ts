import { describe, expect, it } from "vitest";
import { ensureDocId, generateDocId, isValidDocId } from "../id/docid";
import { contentHash, lookupByDeviceDocId, recordUpload } from "../id/mapping";

describe("docid", () => {
	it("generates valid v4-style UUIDs", () => {
		const id = generateDocId();
		expect(isValidDocId(id)).toBe(true);
	});

	it("keeps an existing valid id (idempotent)", () => {
		const id = generateDocId();
		expect(ensureDocId(id)).toEqual({ docId: id, isNew: false });
	});

	it("replaces missing or malformed ids", () => {
		expect(ensureDocId(undefined).isNew).toBe(true);
		expect(ensureDocId("niet-een-uuid").isNew).toBe(true);
	});
});

describe("mapping", () => {
	it("records uploads and finds them by device doc id", () => {
		const table = recordUpload({}, {
			docId: "a",
			notePath: "map/nota.md",
			deviceDocId: "device-1",
			contentHash: contentHash("inhoud"),
		});
		expect(lookupByDeviceDocId(table, "device-1")?.notePath).toBe("map/nota.md");
		expect(table["a"].uploadedAt).toBeTruthy();
	});

	it("hashes content stably and detects changes", () => {
		expect(contentHash("x")).toBe(contentHash("x"));
		expect(contentHash("x")).not.toBe(contentHash("y"));
	});
});
