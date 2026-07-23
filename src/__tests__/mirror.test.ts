import { describe, expect, it } from "vitest";
import { MirrorApi, MirrorEntry, MirrorTransport, toTransportError } from "../transport/mirror";
import { TransportError } from "../transport/http";

function fakeApi(initial: MirrorEntry[] = []) {
	const items = [...initial];
	const calls = { listItems: 0, putFolder: [] as string[], putPdf: [] as string[], moves: [] as [string, string][] };
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
		move: (hash, parent) => {
			calls.moves.push([hash, parent]);
			return Promise.resolve({});
		},
	};
	return { api, items, calls };
}

describe("MirrorTransport.ensureFolderPath", () => {
	it("creates missing segments under the base folder and reuses existing ones", async () => {
		const { api, calls } = fakeApi([
			{ id: "base", hash: "h0", type: "CollectionType", visibleName: "Obsidian", parent: "" },
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
			{ id: "a", hash: "h1", type: "CollectionType", visibleName: "notes", parent: "" },
			{ id: "b", hash: "h2", type: "CollectionType", visibleName: "sub", parent: "elders" },
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
		const result = await mirror.uploadPdf("Nota.pdf", new Uint8Array([1]), "dir-9");
		expect(calls.putPdf).toEqual(["dir-9:Nota"]);
		expect(result.deviceDocId).toMatch(/^doc-/);
	});

	it("moves the previous device copy to trash, ignoring already-gone docs", async () => {
		const { api, calls } = fakeApi([
			{ id: "old-doc", hash: "hash-old", type: "DocumentType", visibleName: "Nota", parent: "" },
		]);
		const mirror = new MirrorTransport(api, "");
		await mirror.trashPrevious("old-doc");
		await mirror.trashPrevious("nonexistent");
		expect(calls.moves).toEqual([["hash-old", "trash"]]);
	});
});

describe("toTransportError", () => {
	it("wraps foreign errors with the fallback advice and keeps TransportErrors", () => {
		const wrapped = toTransportError(new Error("root generation mismatch"));
		expect(wrapped).toBeInstanceOf(TransportError);
		expect(wrapped.message).toContain("Mirror vault folders");
		const original = new TransportError("al netjes");
		expect(toTransportError(original)).toBe(original);
	});
});
