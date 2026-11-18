import { describe, expect, it } from "vitest";
import { GenerationError } from "rmapi-js";
import {
	MirrorApi,
	MirrorEntry,
	MirrorTransport,
	isGenerationConflict,
	toTransportError,
	withGenerationRetry,
} from "../transport/mirror";
import { TransportError } from "../transport/http";

function fakeApi(initial: MirrorEntry[] = []) {
	const items = [...initial];
	const calls = {
		listItems: 0,
		putFolder: [] as string[],
		putPdf: [] as string[],
		putEpub: [] as string[],
		moves: [] as [string, string, string][],
	};
	let nextId = 1;
	const api: MirrorApi = {
		listItems: () => {
			calls.listItems++;
			return Promise.resolve(items);
		},
		putFolder: (visibleName, opts) => {
			calls.putFolder.push(visibleName);
			const entry: MirrorEntry = {
				id: `dir-${nextId}`,
				hash: `hash-dir-${nextId}`,
				type: "CollectionType",
				visibleName,
				parent: opts?.parent ?? "",
			};
			nextId++;
			items.push(entry);
			return Promise.resolve({ id: entry.id, hash: entry.hash });
		},
		putPdf: (visibleName, _buffer, opts) => {
			calls.putPdf.push(`${opts?.parent ?? ""}:${visibleName}`);
			const id = `doc-${nextId++}`;
			return Promise.resolve({ id, hash: `hash-${id}` });
		},
		putEpub: (visibleName, _buffer, opts) => {
			calls.putEpub.push(`${opts?.parent ?? ""}:${visibleName}`);
			const id = `doc-${nextId++}`;
			return Promise.resolve({ id, hash: `hash-${id}` });
		},
		move: (ref, parent) => {
			calls.moves.push([ref.id, ref.hash, parent]);
			return Promise.resolve({});
		},
	};
	return { api, items, calls };
}

describe("MirrorTransport.ensureFolderPath", () => {
	it("reads metadata sequentially without validating document content via listItems", async () => {
		const { api, calls } = fakeApi();
		const seen: string[] = [];
		let active = 0;
		let maxActive = 0;
		api.listRefs = () =>
			Promise.resolve([
				{ id: "base", hash: "h0" },
				{ id: "note", hash: "h1" },
			]);
		api.getMetadata = async ({ id, hash }) => {
			active++;
			maxActive = Math.max(maxActive, active);
			seen.push(`${id}:${hash}`);
			await Promise.resolve();
			active--;
			return {
				visibleName: id === "base" ? "Obsidian" : "Nota",
				lastModified: "1",
				pinned: false,
				parent: "",
				type: id === "base" ? "CollectionType" : "DocumentType",
			};
		};
		const mirror = new MirrorTransport(api, "Obsidian");
		expect(await mirror.ensureFolderPath("")).toBe("base");
		expect(seen).toEqual(["base:h0", "note:h1"]);
		expect(maxActive).toBe(1);
		expect(calls.listItems).toBe(0);
		expect(calls.putFolder).toEqual([]);
	});

	it("skips an item whose metadata fails instead of sinking the listing", async () => {
		const { api, calls } = fakeApi();
		const seen: string[] = [];
		api.listRefs = () =>
			Promise.resolve([
				{ id: "odd", hash: "bad" },
				{ id: "base", hash: "h0" },
			]);
		api.getMetadata = ({ id }) => {
			seen.push(id);
			if (id === "odd") return Promise.reject(new Error("metadata unreadable"));
			return Promise.resolve({
				visibleName: "Obsidian",
				lastModified: "1",
				pinned: false,
				parent: "",
				type: "CollectionType",
			});
		};
		const mirror = new MirrorTransport(api, "Obsidian");
		expect(await mirror.ensureFolderPath("")).toBe("base");
		// The odd one gets a second try at the end (GP_E5_S30).
		expect(seen).toEqual(["odd", "base", "odd"]);
		expect(calls.listItems).toBe(0);
		expect(calls.putFolder).toEqual([]);
	});

	it("creates missing segments under the base folder and reuses existing ones", async () => {
		const { api, calls } = fakeApi([
			{
				id: "base",
				hash: "h0",
				type: "CollectionType",
				visibleName: "Obsidian",
				parent: "",
			},
		]);
		const mirror = new MirrorTransport(api, "Obsidian");
		const id = await mirror.ensureFolderPath("projecten/alpha");

		expect(calls.putFolder).toEqual(["projecten", "alpha"]);
		expect(id).toMatch(/^dir-/);
		// Second resolve of the same path: fully cached, no extra folders.
		await mirror.ensureFolderPath("projecten/alpha");
		expect(calls.putFolder).toEqual(["projecten", "alpha"]);
		// Sibling path reuses the shared prefix.
		await mirror.ensureFolderPath("projecten/beta");
		expect(calls.putFolder).toEqual(["projecten", "alpha", "beta"]);
		expect(calls.listItems).toBe(1);
	});

	it("does not confuse same-named folders under different parents", async () => {
		const { api } = fakeApi([
			{
				id: "a",
				hash: "h1",
				type: "CollectionType",
				visibleName: "notes",
				parent: "",
			},
			{
				id: "b",
				hash: "h2",
				type: "CollectionType",
				visibleName: "sub",
				parent: "elders",
			},
		]);
		const mirror = new MirrorTransport(api, "");
		const id = await mirror.ensureFolderPath("notes/sub");
		// "sub" under "elders" must not be reused for "notes/sub".
		expect(id).not.toBe("b");
	});

	it("returns the vault root as base folder id ('' when no base)", async () => {
		const { api, calls } = fakeApi();
		const mirror = new MirrorTransport(api, "");
		expect(await mirror.ensureFolderPath("")).toBe("");
		expect(calls.putFolder).toEqual([]);
	});
});

describe("MirrorTransport upload + replace", () => {
	it("uploads without the .pdf suffix into the given parent", async () => {
		const { api, calls } = fakeApi();
		const mirror = new MirrorTransport(api, "");
		const result = await mirror.upload("Nota.pdf", new Uint8Array([1]), {
			parentId: "dir-9",
		});
		expect(calls.putPdf).toEqual(["dir-9:Nota"]);
		expect(result.deviceDocId).toMatch(/^doc-/);
	});

	it("routes an EPUB to putEpub and strips the .epub suffix", async () => {
		const { api, calls } = fakeApi();
		const mirror = new MirrorTransport(api, "");
		await mirror.upload("Nota.epub", new Uint8Array([1]), {
			parentId: "dir-9",
			format: "epub",
		});
		expect(calls.putEpub).toEqual(["dir-9:Nota"]);
		expect(calls.putPdf).toEqual([]);
	});

	it("moves the previous device copy to trash, ignoring already-gone docs", async () => {
		const { api, calls } = fakeApi([
			{
				id: "old-doc",
				hash: "hash-old",
				type: "DocumentType",
				visibleName: "Nota",
				parent: "",
			},
		]);
		const mirror = new MirrorTransport(api, "");
		await mirror.trashPrevious("old-doc");
		await mirror.trashPrevious("nonexistent");
		// rmapi-js 14 moves by reference: id and hash together (GP_E5_S28).
		expect(calls.moves).toEqual([["old-doc", "hash-old", "trash"]]);
	});
});

describe("MirrorTransport on an incomplete listing (GP_E5_S30)", () => {
	type Meta = {
		visibleName: string;
		parent: string;
		type: "CollectionType" | "DocumentType";
		createdTime?: string;
	};
	/** A device library whose items fail to read a given number of times. */
	function library(entries: Record<string, Meta>, failures: Record<string, number> = {}) {
		const { api, calls } = fakeApi();
		const reads: string[] = [];
		const left = { ...failures };
		api.listRefs = () =>
			Promise.resolve(Object.keys(entries).map((id) => ({ id, hash: `h-${id}` })));
		api.getMetadata = ({ id }) => {
			reads.push(id);
			if ((left[id] ?? 0) > 0) {
				left[id]--;
				return Promise.reject(new Error("429 too many requests"));
			}
			return Promise.resolve({ ...entries[id], lastModified: "1", pinned: false });
		};
		return { api, calls, reads };
	}

	it("finds the base folder on the second read instead of creating a duplicate", async () => {
		const { api, calls, reads } = library(
			{
				base: { visibleName: "Obsidian", parent: "", type: "CollectionType" },
				doc: { visibleName: "Nota", parent: "base", type: "DocumentType" },
			},
			{ base: 1 },
		);
		const mirror = new MirrorTransport(api, "Obsidian");
		expect(await mirror.ensureFolderPath("")).toBe("base");
		expect(reads).toEqual(["base", "doc", "base"]);
		expect(calls.putFolder).toEqual([]);
	});

	it("creates nothing when the base folder stays unreadable, and says why", async () => {
		const { api, calls } = library(
			{ base: { visibleName: "Obsidian", parent: "", type: "CollectionType" } },
			{ base: 2 },
		);
		const mirror = new MirrorTransport(api, "Obsidian");
		await expect(mirror.ensureFolderPath("")).rejects.toThrow(
			'1 item(s) in your reMarkable library could not be read, so the folder "Obsidian" was not created',
		);
		await expect(mirror.ensureFolderPath("")).rejects.toBeInstanceOf(TransportError);
		expect(calls.putFolder).toEqual([]);
	});

	it("also refuses when another item is unreadable: it could be the folder", async () => {
		const { api, calls } = library(
			{
				base: { visibleName: "Obsidian", parent: "", type: "CollectionType" },
				odd: { visibleName: "?", parent: "", type: "DocumentType" },
			},
			{ odd: 2 },
		);
		const mirror = new MirrorTransport(api, "Obsidian");
		await expect(mirror.ensureFolderPath("projecten")).rejects.toThrow(
			'so the folder "projecten" was not created',
		);
		expect(calls.putFolder).toEqual([]);
	});

	it("still uses a folder it did find while another item is unreadable", async () => {
		const { api, calls } = library(
			{
				base: { visibleName: "Obsidian", parent: "", type: "CollectionType" },
				odd: { visibleName: "?", parent: "", type: "DocumentType" },
			},
			{ odd: 2 },
		);
		const mirror = new MirrorTransport(api, "Obsidian");
		expect(await mirror.ensureFolderPath("")).toBe("base");
		expect(calls.putFolder).toEqual([]);
	});

	it("creates a folder that is really missing when the listing is complete", async () => {
		const { api, calls } = library(
			{ base: { visibleName: "Obsidian", parent: "", type: "CollectionType" } },
			{},
		);
		const mirror = new MirrorTransport(api, "Obsidian");
		await mirror.ensureFolderPath("projecten");
		expect(calls.putFolder).toEqual(["projecten"]);
	});

	it.each([
		["original listed first", ["original", "duplicate"]],
		["duplicate listed first", ["duplicate", "original"]],
	])("picks the oldest of two same-named folders (%s) and says so", async (_label, order) => {
		const meta: Record<string, Meta> = {
			original: {
				visibleName: "Obsidian",
				parent: "",
				type: "CollectionType",
				createdTime: "1700000000000",
			},
			duplicate: {
				visibleName: "Obsidian",
				parent: "",
				type: "CollectionType",
				createdTime: "1763000000000",
			},
		};
		const ordered = Object.fromEntries(order.map((id) => [id, meta[id]]));
		const { api, calls } = library(ordered);
		const mirror = new MirrorTransport(api, "Obsidian");
		expect(await mirror.ensureFolderPath("")).toBe("original");
		expect(calls.putFolder).toEqual([]);
		expect(mirror.warnings).toHaveLength(1);
		expect(mirror.warnings[0]).toContain('2 folders named "Obsidian"');
		// Warned once per folder, however often it is looked up.
		await mirror.ensureFolderPath("");
		expect(mirror.warnings).toHaveLength(1);
	});
});

describe("generation conflicts", () => {
	const NO_WAIT = { backoffMs: () => 0, sleep: () => Promise.resolve() };

	it("recognises the conflict in its various guises", () => {
		const named = new Error("boem");
		named.name = "GenerationError";
		expect(isGenerationConflict(named)).toBe(true);
		expect(isGenerationConflict(new Error("precondition failed"))).toBe(true);
		expect(
			isGenerationConflict(new Error("Failed to upload root schema")),
		).toBe(true);
		expect(isGenerationConflict(new Error("gewoon kapot"))).toBe(false);
	});

	it("recognises rmapi-js' real GenerationError (GP_E5_S1)", () => {
		// The real class does not (currently) assign `this.name`, so at runtime
		// it can carry name === "Error" — the guise the field failure arrived
		// in. Guard the instanceof path and the message fallback for re-wrapped
		// errors; deliberately no assertion on `.name` itself, so an upstream
		// fix that starts setting it does not break this test.
		expect(isGenerationConflict(new GenerationError())).toBe(true);
		expect(
			isGenerationConflict(
				new Error("root generation was stale; try put again"),
			),
		).toBe(true);
	});

	it("retries the real GenerationError and reports it as busy-sync", async () => {
		let calls = 0;
		const result = await withGenerationRetry(() => {
			calls++;
			return calls < 2
				? Promise.reject(new GenerationError())
				: Promise.resolve("ok");
		}, NO_WAIT);
		expect(result).toBe("ok");
		expect(calls).toBe(2);
		const reported = toTransportError(new GenerationError());
		expect(reported.message).toContain("busy syncing");
		expect(reported.message).not.toContain("Folder mirroring failed");
	});

	it("retries with a refreshed view and succeeds", async () => {
		const seen: boolean[] = [];
		let calls = 0;
		const result = await withGenerationRetry((refresh) => {
			seen.push(refresh);
			calls++;
			return calls < 3
				? Promise.reject(new Error("Failed to upload root schema"))
				: Promise.resolve("ok");
		}, NO_WAIT);
		expect(result).toBe("ok");
		// First attempt without refresh, retries with.
		expect(seen).toEqual([false, true, true]);
	});

	it("does not retry unrelated failures", async () => {
		let calls = 0;
		await expect(
			withGenerationRetry(() => {
				calls++;
				return Promise.reject(new Error("gewoon kapot"));
			}, NO_WAIT),
		).rejects.toThrow(/gewoon kapot/);
		expect(calls).toBe(1);
	});

	it("retries an upload that hits a busy cloud, refreshing the tree", async () => {
		const { api, calls } = fakeApi();
		let attempts = 0;
		const flaky: MirrorApi = {
			...api,
			putPdf: (name, buffer, opts) => {
				attempts++;
				if (attempts === 1)
					return Promise.reject(new Error("precondition failed"));
				return api.putPdf(name, buffer, opts);
			},
		};
		const mirror = new MirrorTransport(flaky, "", NO_WAIT);
		const result = await mirror.upload("Nota.pdf", new Uint8Array([1]), {
			parentId: "dir-1",
		});
		expect(attempts).toBe(2);
		expect(calls.putPdf).toEqual(["dir-1:Nota"]);
		expect(result.deviceDocId).toMatch(/^doc-/);
	});

	it("explains a persistent conflict in plain language", () => {
		const message = toTransportError(
			new Error("Failed to upload root schema"),
		).message;
		expect(message).toContain("busy syncing");
		expect(message).toContain("Nothing was lost");
	});
});

describe("toTransportError", () => {
	it("wraps foreign errors with the fallback advice and keeps TransportErrors", () => {
		const wrapped = toTransportError(new Error("iets heel anders ging stuk"));
		expect(wrapped).toBeInstanceOf(TransportError);
		expect(wrapped.message).toContain("Mirror vault folders");
		const original = new TransportError("al netjes");
		expect(toTransportError(original)).toBe(original);
	});
});
