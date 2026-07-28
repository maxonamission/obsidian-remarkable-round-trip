import { describe, expect, it } from "vitest";
import { PageMap, pageIdOfFile, parsePageEntries, parsePageOrder } from "../incoming/pagemap";

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

describe("pages added on the device", () => {
	// GP_E3_S20: the reMarkable can insert a blank page into a PDF to write on.
	// It shows no source page — `redir` says which PDF page a page shows, and
	// an added page carries none — and it shifts every page after it.
	const content = JSON.stringify({
		cPages: {
			pages: [
				{ id: "p1", redir: { value: 0 } },
				{ id: "p2", redir: { value: 1 } },
				{ id: "added", redir: { value: -1 } },
				{ id: "p3", redir: { value: 2 } },
			],
		},
	});

	it("maps each page to the source page it shows", () => {
		expect(parsePageEntries(content)).toEqual([
			{ id: "p1", pdfPage: 1 },
			{ id: "p2", pdfPage: 2 },
			{ id: "added", pdfPage: null },
			{ id: "p3", pdfPage: 3 },
		]);
	});

	it("keeps later pages pointing at the right source page", () => {
		// Without this, the page after the insertion would be quoted against
		// page 4 of the note, which is one page too far.
		const map = new PageMap(parsePageEntries(content));
		expect(map.forFile("doc/p3.rm")).toBe(3);
		expect(map.positionOf("doc/p3.rm")).toBe(4);
	});

	it("recognises an added page and where it belongs", () => {
		const map = new PageMap(parsePageEntries(content));
		expect(map.isAdded("doc/added.rm")).toBe(true);
		expect(map.forFile("doc/added.rm")).toBeUndefined();
		expect(map.precedingPdfPage("doc/added.rm")).toBe(2);
		expect(map.addedPages).toHaveLength(1);
	});

	it("falls back to the old assumption when no page records a redirect", () => {
		// Older firmware writes no redirects at all; then page N showing PDF
		// page N is still the best available answer (N3).
		const plain = JSON.stringify({ cPages: { pages: [{ id: "a" }, { id: "b" }] } });
		expect(parsePageEntries(plain)).toEqual([
			{ id: "a", pdfPage: 1 },
			{ id: "b", pdfPage: 2 },
		]);
	});
});
