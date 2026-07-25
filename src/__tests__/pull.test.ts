import { describe, expect, it } from "vitest";
import { MappingTable } from "../id/mapping";
import { Highlight } from "../incoming/highlights";
import { DocumentFile, PullDeps, collectHighlights, pullAnnotations } from "../incoming/pull";

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
			Promise.resolve(file.id.endsWith("p1.json") ? page("van pagina 1") : page("van pagina 2")),
		readPageOrder: () => Promise.resolve(["p1", "p2"]),
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
		const { highlights, scan } = await collectHighlights("device-a", "hash-1", deps);
		expect(highlights.map((h) => h.text)).toEqual(["van pagina 1", "van pagina 2"]);
		expect(highlights.map((h) => h.page)).toEqual([1, 2]);
		expect(scan).toMatchObject({ totalFiles: 4, highlightFiles: 2, strokeFiles: 1 });
	});

	it("returns nothing when the document has no highlight files", async () => {
		const { deps } = makeDeps({
			listDocumentFiles: () => Promise.resolve([{ id: "device-a.content", hash: "h" }]),
		});
		const { highlights, scan } = await collectHighlights("device-a", "hash-1", deps);
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
		const { highlights, scan } = await collectHighlights("device-a", "hash-1", deps);
		expect(highlights.map((h) => h.text)).toEqual(["van pagina 2"]);
		expect(scan.unreadableFiles).toBe(1);
	});

	it("still returns highlights when the page order is unavailable", async () => {
		const { deps } = makeDeps({ readPageOrder: undefined });
		const { highlights } = await collectHighlights("device-a", "hash-1", deps);
		expect(highlights).toHaveLength(2);
		expect(highlights.every((h) => h.page === undefined)).toBe(true);
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
