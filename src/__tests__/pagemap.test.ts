import { describe, expect, it } from "vitest";
import { PageMap, pageIdOfFile, parsePageOrder } from "../incoming/pagemap";

describe("parsePageOrder", () => {
	it("reads the current format", () => {
		const content = JSON.stringify({
			cPages: { pages: [{ id: "aaa" }, { id: "bbb" }, { id: "ccc" }] },
		});
		expect(parsePageOrder(content)).toEqual(["aaa", "bbb", "ccc"]);
	});

	it("leaves deleted pages out, so later pages keep the right number", () => {
		const content = JSON.stringify({
			cPages: { pages: [{ id: "aaa" }, { id: "bbb", deleted: { value: 1 } }, { id: "ccc" }] },
		});
		expect(parsePageOrder(content)).toEqual(["aaa", "ccc"]);
	});

	it("reads the older flat format", () => {
		expect(parsePageOrder(JSON.stringify({ pages: ["x", "y"] }))).toEqual(["x", "y"]);
	});

	it("gives up quietly on anything it does not recognise", () => {
		expect(parsePageOrder("niet eens json")).toEqual([]);
		expect(parsePageOrder(JSON.stringify({ iets: "anders" }))).toEqual([]);
		expect(parsePageOrder(JSON.stringify([1, 2, 3]))).toEqual([]);
	});
});

describe("pageIdOfFile", () => {
	it("finds the page id of stroke and highlight files", () => {
		expect(pageIdOfFile("doc/aaa.rm")).toBe("aaa");
		expect(pageIdOfFile("doc.highlights/bbb.json")).toBe("bbb");
	});

	it("returns null for files that are not per-page", () => {
		expect(pageIdOfFile("doc.content")).toBeNull();
		expect(pageIdOfFile("doc.pagedata")).toBeNull();
	});
});

describe("PageMap", () => {
	const map = new PageMap(["aaa", "bbb", "ccc"]);

	it("numbers pages from one, by their place in the document", () => {
		expect(map.forFile("doc/ccc.rm")).toBe(3);
		expect(map.forFile("doc.highlights/aaa.json")).toBe(1);
	});

	it("says nothing rather than guessing for an unknown page", () => {
		// The beta bug this replaces: numbering by file order made a remark on
		// page 7 report as page 1.
		expect(map.forFile("doc/zzz.rm")).toBeUndefined();
		expect(map.forFile("doc.content")).toBeUndefined();
	});
});
