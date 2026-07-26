import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PdfLayout } from "../convert/pdf";
import { MappingTable } from "../id/mapping";
import { Highlight } from "../incoming/highlights";
import {
	DocumentFile,
	PullDeps,
	StrokeRenderRequest,
	collectHighlights,
	pullAnnotations,
} from "../incoming/pull";

const TABLE: MappingTable = {
	"doc-a": {
		docId: "doc-a",
		notePath: "map/Nota.md",
		deviceDocId: "device-a",
		uploadedAt: "2026-07-25T10:00:00Z",
		contentHash: "aaaa",
	},
};

const page = (text: string) => JSON.stringify({ highlights: [[{ text, color: 3 }]] });
const CONTENT = JSON.stringify({ cPages: { pages: [{ id: "p1" }, { id: "p2" }] } });

function makeDeps(overrides: Partial<PullDeps> = {}) {
	const written: { notePath: string; highlights: Highlight[] }[] = [];
	const files: DocumentFile[] = [
		{ id: "device-a.content", hash: "h-content" },
		{ id: "device-a.highlights/p2.json", hash: "h-p2" },
		{ id: "device-a.highlights/p1.json", hash: "h-p1" },
		{ id: "device-a/p1.rm", hash: "h-rm" },
	];
	const deps: PullDeps = {
		listDocumentHashes: () => Promise.resolve(new Map([["device-a", "hash-1"]])),
		listDocumentFiles: () => Promise.resolve(files),
		readFile: (file) =>
			Promise.resolve(
				file.id.endsWith(".content")
					? CONTENT
					: file.id.endsWith("p1.json")
						? page("van pagina 1")
						: page("van pagina 2"),
			),
		writeAnnotations: (entry, highlights) => {
			written.push({ notePath: entry.notePath, highlights });
			return Promise.resolve();
		},
		...overrides,
	};
	return { deps, written };
}

describe("collectHighlights", () => {
	it("reads only highlight files and orders them by page", async () => {
		const { deps } = makeDeps();
		const { highlights, scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(highlights.map((h) => h.text)).toEqual(["van pagina 1", "van pagina 2"]);
		expect(highlights.map((h) => h.page)).toEqual([1, 2]);
		expect(scan).toMatchObject({ totalFiles: 4, highlightFiles: 2, strokeFiles: 1 });
	});

	it("returns nothing when the document has no highlight files", async () => {
		const { deps } = makeDeps({
			listDocumentFiles: () => Promise.resolve([{ id: "device-a.content", hash: "h" }]),
		});
		const { highlights, scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(highlights).toEqual([]);
		expect(scan).toMatchObject({ highlightFiles: 0, strokeFiles: 0, totalFiles: 1 });
	});

	it("skips a page it cannot read instead of failing the document", async () => {
		const { deps } = makeDeps({
			readFile: (file) =>
				file.id.endsWith("p1.json")
					? Promise.reject(new Error("stuk"))
					: Promise.resolve(page("van pagina 2")),
		});
		const { highlights, scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(highlights.map((h) => h.text)).toEqual(["van pagina 2"]);
		expect(scan.unreadableFiles).toBe(1);
	});

	it("still returns highlights when the page order is unavailable", async () => {
		const { deps } = makeDeps({ readFile: () => Promise.resolve(page("zonder volgorde")) });
		const { highlights } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(highlights).toHaveLength(2);
		expect(highlights.every((h) => h.page === undefined)).toBe(true);
	});
});

describe("handwriting import", () => {
	const realPage = new Uint8Array(
		readFileSync(fileURLToPath(new URL("./fixtures/lines-v2.rm", import.meta.url))),
	);
	const layout: PdfLayout = {
		pageWidth: 447,
		pageHeight: 596,
		pageCount: 1,
		// The fixture's ink covers device y 86–171, which is PDF y 542–569.
		lines: [{ page: 1, x: 40, y: 550, size: 11, text: "De zin waar de inkt bij hoort." }],
	};

	function handwritingDeps(overrides: Partial<PullDeps> = {}) {
		const requests: StrokeRenderRequest[] = [];
		const { deps, written } = makeDeps({
			readBytes: () => Promise.resolve(realPage),
			renderStrokes: (request) => {
				requests.push(request);
				return Promise.resolve(`img/${request.page}-${request.remark}.png`);
			},
			...overrides,
		});
		return { deps, requests, written };
	}

	it("numbers a remark by its page in the document, not by file order", async () => {
		// The stroke file is p1.rm, but `.content` lists p1 first — so the
		// number must come from there, which is what the beta got wrong.
		const { deps, requests } = handwritingDeps();
		const { images } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(requests.every((request) => request.page === 1)).toBe(true);
		expect(images.every((image) => image.page === 1)).toBe(true);
	});

	it("counts remarks and pages separately", async () => {
		// One drawing on one page: the fixture's ten strokes belong together,
		// so they must not come back as ten images. Splitting itself is
		// covered in anchor.test.ts.
		const { deps, requests } = handwritingDeps();
		const { scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(requests).toHaveLength(1);
		expect(scan.renderedRemarks).toBe(1);
		expect(scan.renderedPages).toBe(1);
		expect(new Set(requests.map((r) => r.remark)).size).toBe(requests.length);
	});

	it("quotes the text a remark sits against when the layout is available", async () => {
		const { deps } = handwritingDeps({ loadLayout: () => Promise.resolve(layout) });
		const { images, scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(images.some((image) => image.quote?.includes("De zin waar de inkt"))).toBe(true);
		expect(scan.anchoredRemarks).toBeGreaterThan(0);
		expect(scan.anchorSkipped).toBeUndefined();
	});

	it("still returns the images when the layout cannot be reproduced", async () => {
		const { deps } = handwritingDeps({ loadLayout: () => Promise.resolve(null) });
		const { images, scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(images.length).toBeGreaterThan(0);
		expect(images.every((image) => image.quote === undefined)).toBe(true);
		expect(scan.anchorSkipped).toBe("no-layout");
	});

	it("survives a stroke file it cannot read", async () => {
		const { deps } = handwritingDeps({
			readBytes: () => Promise.reject(new Error("stuk")),
		});
		const { scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(scan.renderedRemarks).toBe(0);
		expect(scan.unreadableFiles).toBe(1);
	});

	it("does nothing at all when handwriting import is switched off", async () => {
		const { deps } = makeDeps({ readBytes: () => Promise.resolve(realPage) });
		const { images, scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(images).toEqual([]);
		expect(scan.renderedPages).toBe(0);
	});
});

describe("pullAnnotations", () => {
	it("imports a changed document and records the device hash", async () => {
		const { deps, written } = makeDeps();
		const { results, table } = await pullAnnotations(TABLE, deps);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ ok: true, highlightCount: 2 });
		expect(written[0].notePath).toBe("map/Nota.md");
		expect(table["doc-a"].importedHash).toBe("hash-1");
	});

	it("skips a document whose device hash is unchanged", async () => {
		const { deps, written } = makeDeps();
		const seen: MappingTable = {
			"doc-a": { ...TABLE["doc-a"], importedHash: "hash-1" },
		};
		const { results } = await pullAnnotations(seen, deps);
		expect(results[0]).toMatchObject({ ok: true, skipped: true });
		expect(written).toHaveLength(0);
	});

	it("re-imports an unchanged document when forced", async () => {
		const { deps, written } = makeDeps({ force: true });
		const seen: MappingTable = {
			"doc-a": { ...TABLE["doc-a"], importedHash: "hash-1" },
		};
		await pullAnnotations(seen, deps);
		expect(written).toHaveLength(1);
	});

	it("treats a document that is gone from the device as nothing to do", async () => {
		const { deps, written } = makeDeps({
			listDocumentHashes: () => Promise.resolve(new Map()),
		});
		const { results } = await pullAnnotations(TABLE, deps);
		expect(results[0]).toMatchObject({ ok: true, skipped: true });
		expect(written).toHaveLength(0);
	});

	it("reports a per-document failure without aborting the run", async () => {
		const table: MappingTable = {
			...TABLE,
			"doc-b": { ...TABLE["doc-a"], docId: "doc-b", deviceDocId: "device-b", notePath: "b.md" },
		};
		const { deps } = makeDeps({
			listDocumentHashes: () =>
				Promise.resolve(
					new Map([
						["device-a", "hash-1"],
						["device-b", "hash-2"],
					]),
				),
			listDocumentFiles: (deviceDocId) =>
				deviceDocId === "device-b"
					? Promise.reject(new Error("cloud weigert"))
					: Promise.resolve([{ id: "device-a.highlights/p1.json", hash: "h" }]),
		});
		const { results, table: updated } = await pullAnnotations(table, deps);
		expect(results.map((r) => r.ok)).toEqual([true, false]);
		expect(updated["doc-a"].importedHash).toBe("hash-1");
		expect(updated["doc-b"].importedHash).toBeUndefined();
	});

	it("reports every mapping as failed when the device is unreachable", async () => {
		const { deps } = makeDeps({
			listDocumentHashes: () => Promise.reject(new Error("geen verbinding")),
		});
		const { results, table } = await pullAnnotations(TABLE, deps);
		expect(results[0]).toMatchObject({ ok: false, error: "geen verbinding" });
		expect(table).toEqual(TABLE);
	});
});
