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
		moves: [] as [string, string][],
		renames: [] as [string, string][],
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
		move: (hash, parent) => {
			calls.moves.push([hash, parent]);
			const entry = items.find((item) => item.hash === hash);
			const nextHash = `${hash}-moved`;
			if (entry) {
				entry.parent = parent;
				entry.hash = nextHash;
			}
			return Promise.resolve({ hash: nextHash });
		},
		rename: (hash, visibleName) => {
			calls.renames.push([hash, visibleName]);
			const entry = items.find((item) => item.hash === hash);
			const nextHash = `${hash}-renamed`;
			if (entry) {
				entry.visibleName = visibleName;
				entry.hash = nextHash;
			}
			return Promise.resolve({ hash: nextHash });
		},
	};
	return { api, items, calls };
}

describe("MirrorTransport.ensureFolderPath", () => {
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

describe("MirrorTransport.documentsInMirrorRoot", () => {
	it("reads metadata sequentially instead of using listItems Promise.all", async () => {
		let active = 0;
		let maxActive = 0;
		const mirror = new MirrorTransport(
			{
				listItems: () => Promise.reject(new Error("listItems should not run")),
				listIds: () =>
					Promise.resolve([
						{ id: "one", hash: "hash-one" },
						{ id: "two", hash: "hash-two" },
					]),
				getMetadata: async (id) => {
					active++;
					maxActive = Math.max(maxActive, active);
					await Promise.resolve();
					active--;
					return {
						visibleName: id,
						lastModified: "0",
						pinned: false,
						parent: "",
						type: "DocumentType" as const,
					};
				},
				putFolder: () => Promise.reject(new Error("unused")),
				putPdf: () => Promise.reject(new Error("unused")),
				putEpub: () => Promise.reject(new Error("unused")),
				move: () => Promise.reject(new Error("unused")),
				rename: () => Promise.reject(new Error("unused")),
			},
			"",
		);

		expect(
			(await mirror.documentsInMirrorRoot()).map((item) => item.deviceDocId),
		).toEqual(["one", "two"]);
		expect(maxActive).toBe(1);
	});

	it("returns only non-trashed documents below the configured base folder", async () => {
		const { api } = fakeApi([
			{
				id: "base",
				hash: "base-hash",
				type: "CollectionType",
				visibleName: "Obsidian",
				parent: "",
			},
			{
				id: "inside",
				hash: "inside-hash",
				type: "DocumentType",
				visibleName: "Inside",
				parent: "base",
			},
			{
				id: "outside",
				hash: "outside-hash",
				type: "DocumentType",
				visibleName: "Outside",
				parent: "",
			},
			{
				id: "trashed",
				hash: "trashed-hash",
				type: "DocumentType",
				visibleName: "Trashed",
				parent: "trash",
			},
		]);

		const documents = await new MirrorTransport(
			api,
			"Obsidian",
		).documentsInMirrorRoot();
		expect(documents.map((entry) => entry.deviceDocId)).toEqual(["inside"]);
	});
});

describe("MirrorTransport upload + replace", () => {
	it("tracks a document's full remote path", async () => {
		const { api } = fakeApi([
			{
				id: "base",
				hash: "hb",
				type: "CollectionType",
				visibleName: "Obsidian",
			},
			{
				id: "folder",
				hash: "hf",
				type: "CollectionType",
				visibleName: "Projects",
				parent: "base",
			},
			{
				id: "doc",
				hash: "hd",
				type: "DocumentType",
				visibleName: "Plan",
				parent: "folder",
			},
		]);
		const mirror = new MirrorTransport(api, "Obsidian");

		expect(await mirror.documentState("doc")).toMatchObject({
			remotePath: "Obsidian/Projects/Plan",
			parentId: "folder",
		});
		expect(await mirror.documentState("missing")).toBeNull();
	});

	it("restores a remotely moved and renamed document without re-uploading", async () => {
		const { api, calls } = fakeApi([
			{
				id: "target",
				hash: "ht",
				type: "CollectionType",
				visibleName: "Target",
			},
			{
				id: "doc",
				hash: "hd",
				type: "DocumentType",
				visibleName: "Remote name",
				parent: "trash",
			},
		]);
		const mirror = new MirrorTransport(api, "");
		const state = await mirror.documentState("doc");
		expect(state).not.toBeNull();

		await mirror.relocateDocument(state!, "target", "Local name");
		expect(calls.moves).toEqual([["hd", "target"]]);
		expect(calls.renames).toEqual([["hd-moved", "Local name"]]);
		expect(await mirror.documentState("doc")).toMatchObject({
			remotePath: "Target/Local name",
		});
	});

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
		expect(calls.moves).toEqual([["hash-old", "trash"]]);
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
