import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PdfLayout } from "../convert/pdf";
import { RM_V6_HEADER } from "../incoming/rmlines";
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

/** A `.rm` v6 page holding one glyph block — a text highlight (GP_E3_S11). */
function glyphPage(text: string, color: number): Uint8Array {
	const encoded = new TextEncoder().encode(text);
	const body: number[] = [];
	for (let i = 1; i <= 4; i++) body.push((i << 4) | 0xf, 1, 0);
	body.push(0x5f, 0, 0, 0, 0);
	body.push(0x44, color, 0, 0, 0);
	const blockLength = 2 + encoded.length;
	body.push(0x5c, blockLength & 0xff, (blockLength >> 8) & 0xff, 0, 0);
	body.push(encoded.length, 1, ...encoded);

	const header = new TextEncoder().encode(RM_V6_HEADER);
	const out = new Uint8Array(header.length + 8 + body.length);
	out.set(header, 0);
	new DataView(out.buffer).setUint32(header.length, body.length, true);
	out[header.length + 6] = 2;
	out[header.length + 7] = 0x03;
	out.set(body, header.length + 8);
	return out;
}
const CONTENT = JSON.stringify({
	cPages: { pages: [{ id: "p1" }, { id: "p2" }] },
});

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
		expect(scan).toMatchObject({
			totalFiles: 4,
			highlightFiles: 2,
			strokeFiles: 1,
		});
	});

	it("returns nothing when the document has no highlight files", async () => {
		const { deps } = makeDeps({
			listDocumentFiles: () => Promise.resolve([{ id: "device-a.content", hash: "h" }]),
		});
		const { highlights, scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(highlights).toEqual([]);
		expect(scan).toMatchObject({
			highlightFiles: 0,
			strokeFiles: 0,
			totalFiles: 1,
		});
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
		const { deps } = makeDeps({
			readFile: () => Promise.resolve(page("zonder volgorde")),
		});
		const { highlights } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(highlights).toHaveLength(2);
		expect(highlights.every((h) => h.page === undefined)).toBe(true);
	});
});

describe("pen mark import", () => {
	const realPage = new Uint8Array(
		readFileSync(fileURLToPath(new URL("./fixtures/lines-v2.rm", import.meta.url))),
	);
	// The fixture's ink covers device y 86–171, which is PDF y 542–569; a line
	// at 550 sits right under it.
	const layout: PdfLayout = {
		pageWidth: 447,
		pageHeight: 596,
		pageCount: 1,
		lines: [
			{
				page: 1,
				x: 40,
				y: 550,
				size: 11,
				text: "De zin waar de inkt bij hoort.",
				block: 1,
				role: "paragraph" as const,
				words: [
					{ id: 1, text: "De", x: 40, width: 12 },
					{ id: 2, text: "zin", x: 55, width: 14 },
					{ id: 3, text: "waar", x: 72, width: 22 },
					{ id: 4, text: "de", x: 97, width: 12 },
					{ id: 5, text: "inkt", x: 112, width: 18 },
					{ id: 6, text: "bij", x: 133, width: 12 },
					{ id: 7, text: "hoort.", x: 148, width: 28 },
				],
			},
		],
	};

	function markDeps(overrides: Partial<PullDeps> = {}) {
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

	it("numbers a mark by its page in the document, not by file order", async () => {
		// The stroke file is p1.rm and `.content` lists p1 first — so the
		// number comes from there, which is what the beta got wrong.
		const { deps } = markDeps();
		const { marks } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(marks.length).toBeGreaterThan(0);
		expect(marks.every((mark) => mark.page === 1)).toBe(true);
	});

	it("keeps the strokes of one drawing together as a single note", async () => {
		const { deps, requests } = markDeps();
		const { scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(requests).toHaveLength(1);
		expect(scan.renderedRemarks).toBe(1);
		expect(scan.renderedPages).toBe(1);
	});

	it("quotes the text a note sits against when the layout is available", async () => {
		const { deps } = markDeps({ loadLayout: () => Promise.resolve(layout) });
		const { marks, scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(marks.some((mark) => mark.quote?.includes("De zin waar de inkt"))).toBe(true);
		expect(scan.anchoredRemarks).toBeGreaterThan(0);
		expect(scan.anchorSkipped).toBeUndefined();
	});

	it("still returns the ink when the layout cannot be reproduced", async () => {
		const { deps } = markDeps({ loadLayout: () => Promise.resolve(null) });
		const { marks, scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(marks.length).toBeGreaterThan(0);
		expect(marks.every((mark) => mark.kind === "note" && mark.path !== undefined)).toBe(true);
		expect(marks.every((mark) => mark.quote === undefined)).toBe(true);
		expect(scan.anchorSkipped).toBe("no-layout");
	});

	it("survives a stroke file it cannot read", async () => {
		const { deps } = markDeps({
			readBytes: () => Promise.reject(new Error("stuk")),
		});
		const { scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(scan.renderedRemarks).toBe(0);
		expect(scan.unreadableFiles).toBe(1);
	});

	it("renders no images when handwriting import is switched off", async () => {
		const { deps } = makeDeps({ readBytes: () => Promise.resolve(realPage) });
		const { marks, scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);
		expect(marks.every((mark) => mark.path === undefined)).toBe(true);
		expect(scan.renderedPages).toBe(0);
	});

	it("takes the text highlights out of the pen layer, even without rendering", async () => {
		// The beta account held no `.highlights/*.json` at all; the highlights
		// sat inside the page's own `.rm` file (GP_E3_S11).
		const withGlyph = glyphPage("Maar is er altijd zekerheid uit data?", 2);
		const { deps } = makeDeps({
			listDocumentFiles: () =>
				Promise.resolve([
					{ id: "device-a.content", hash: "h-content" },
					{ id: "device-a/p1.rm", hash: "h-rm" },
				]),
			readFile: () => Promise.resolve(CONTENT),
			readBytes: () => Promise.resolve(withGlyph),
		});
		const { highlights, scan } = await collectHighlights(TABLE["doc-a"], "hash-1", deps);

		expect(highlights).toEqual([
			{ text: "Maar is er altijd zekerheid uit data?", color: 2, page: 1 },
		]);
		expect(scan.highlightsInStrokes).toBe(1);
		expect(scan.highlightFiles).toBe(0);
		expect(scan.parsedHighlights).toBe(1);
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
			"doc-b": {
				...TABLE["doc-a"],
				docId: "doc-b",
				deviceDocId: "device-b",
				notePath: "b.md",
			},
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

	it("records how the source note relates to what was sent (F14)", async () => {
		const { deps } = makeDeps({ checkSource: () => Promise.resolve("changed" as const) });
		const { results } = await pullAnnotations(TABLE, deps);
		expect(results[0]).toMatchObject({ ok: true, scan: { sourceState: "changed" } });
	});

	it("still imports when the source check itself fails — it is a diagnosis, not a gate", async () => {
		const table: MappingTable = {
			...TABLE,
			"doc-b": {
				...TABLE["doc-a"],
				docId: "doc-b",
				deviceDocId: "device-b",
				notePath: "b.md",
			},
		};
		const { deps, written } = makeDeps({
			listDocumentHashes: () =>
				Promise.resolve(
					new Map([
						["device-a", "hash-1"],
						["device-b", "hash-2"],
					]),
				),
			checkSource: (entry) =>
				entry.docId === "doc-b"
					? Promise.reject(new Error("vault weigert"))
					: Promise.resolve("match" as const),
		});
		const { results } = await pullAnnotations(table, deps);
		expect(results.map((r) => r.ok)).toEqual([true, true]);
		expect(results[1]).toMatchObject({ scan: { sourceState: undefined } });
		expect(written).toHaveLength(2);
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
