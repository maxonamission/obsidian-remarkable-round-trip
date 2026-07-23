import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { NoteInput, SendDeps, sendBatch, sendNote } from "../sync/send";
import { DOCID_SUBJECT_PREFIX } from "../convert/pdf";
import { isValidDocId } from "../id/docid";

function makeDeps(overrides: Partial<SendDeps> = {}) {
	const uploads: { fileName: string; bytes: Uint8Array }[] = [];
	const persisted: { path: string; docId: string }[] = [];
	const deps: SendDeps = {
		client: {
			uploadPdf: (fileName, bytes) => {
				uploads.push({ fileName, bytes });
				return Promise.resolve({ deviceDocId: `device-${uploads.length}` });
			},
		},
		resolveEmbed: () => ({ kind: "missing" }),
		persistDocId: (note, docId) => {
			persisted.push({ path: note.path, docId });
			return Promise.resolve();
		},
		...overrides,
	};
	return { deps, uploads, persisted };
}

const NOTE: NoteInput = {
	path: "map/Nota.md",
	basename: "Nota",
	content: "---\ntitle: X\n---\nInhoud van de notitie.",
};

describe("sendNote", () => {
	it("generates and persists a docId, uploads, and records the mapping", async () => {
		const { deps, uploads, persisted } = makeDeps();
		const { result, table } = await sendNote(NOTE, {}, deps);

		if (!result.ok) throw new Error(`unexpected failure: ${result.error}`);
		expect(isValidDocId(result.docId)).toBe(true);
		expect(persisted).toEqual([{ path: "map/Nota.md", docId: result.docId }]);
		expect(uploads[0].fileName).toBe("Nota.pdf");
		expect(table[result.docId]).toMatchObject({
			notePath: "map/Nota.md",
			deviceDocId: "device-1",
		});

		const doc = await PDFDocument.load(uploads[0].bytes);
		expect(doc.getSubject()).toBe(`${DOCID_SUBJECT_PREFIX}${result.docId}`);
	});

	it("reuses an existing docId without persisting again", async () => {
		const { deps, persisted } = makeDeps();
		const existing = "0f8fad5b-d9cb-469f-a165-70867728950e";
		const { result } = await sendNote({ ...NOTE, existingDocId: existing }, {}, deps);
		if (!result.ok) throw new Error("unexpected failure");
		expect(result.docId).toBe(existing);
		expect(persisted).toHaveLength(0);
	});

	it("returns a failure result instead of throwing", async () => {
		const { deps } = makeDeps({
			client: { uploadPdf: () => Promise.reject(new Error("cloud down")) },
		});
		const { result, table } = await sendNote(NOTE, {}, deps);
		expect(result).toMatchObject({ ok: false, error: "cloud down" });
		expect(table).toEqual({});
	});
});

describe("sendNote skipUnchanged", () => {
	it("skips the upload when content is unchanged, and sends when it changed", async () => {
		const { deps, uploads } = makeDeps({ skipUnchanged: true });
		const first = await sendNote(NOTE, {}, deps);
		if (!first.result.ok) throw new Error("unexpected failure");
		expect(uploads).toHaveLength(1);

		const again = await sendNote(
			{ ...NOTE, existingDocId: first.result.docId },
			first.table,
			deps,
		);
		if (!again.result.ok) throw new Error("unexpected failure");
		expect(again.result.skipped).toBe(true);
		expect(uploads).toHaveLength(1);

		const changed = await sendNote(
			{ ...NOTE, content: `${NOTE.content}\nExtra regel.`, existingDocId: first.result.docId },
			again.table,
			deps,
		);
		if (!changed.result.ok) throw new Error("unexpected failure");
		expect(changed.result.skipped).toBeUndefined();
		expect(uploads).toHaveLength(2);
	});
});

describe("sendNote folder mirroring hooks", () => {
	it("uploads into the resolved parent and retires the previous device copy", async () => {
		const trashed: string[] = [];
		const parents: string[] = [];
		const { deps, uploads } = makeDeps({
			resolveParent: (notePath) => {
				parents.push(notePath);
				return Promise.resolve("dir-42");
			},
			replacePrevious: (id) => {
				trashed.push(id);
				return Promise.resolve();
			},
		});
		const uploadArgs: (string | undefined)[] = [];
		deps.client = {
			uploadPdf: (fileName, bytes, parentId) => {
				uploadArgs.push(parentId);
				uploads.push({ fileName, bytes });
				return Promise.resolve({ deviceDocId: `device-${uploads.length}` });
			},
		};

		const first = await sendNote(NOTE, {}, deps);
		if (!first.result.ok) throw new Error("unexpected failure");
		const second = await sendNote(
			{ ...NOTE, content: `${NOTE.content}\nGewijzigd.`, existingDocId: first.result.docId },
			first.table,
			deps,
		);
		if (!second.result.ok) throw new Error("unexpected failure");

		expect(parents).toEqual(["map/Nota.md", "map/Nota.md"]);
		expect(uploadArgs).toEqual(["dir-42", "dir-42"]);
		expect(trashed).toEqual(["device-1"]);
	});

	it("treats a failing replacePrevious as non-fatal", async () => {
		const { deps } = makeDeps({
			replacePrevious: () => Promise.reject(new Error("trash faalt")),
		});
		const first = await sendNote(NOTE, {}, deps);
		if (!first.result.ok) throw new Error("unexpected failure");
		const second = await sendNote(
			{ ...NOTE, content: "ander", existingDocId: first.result.docId },
			first.table,
			deps,
		);
		expect(second.result.ok).toBe(true);
	});
});

describe("sendBatch", () => {
	it("continues after a failure and reports per file", async () => {
		let calls = 0;
		const { deps } = makeDeps({
			client: {
				uploadPdf: () => {
					calls++;
					return calls === 1
						? Promise.reject(new Error("eerste faalt"))
						: Promise.resolve({ deviceDocId: `device-${calls}` });
				},
			},
		});
		const progress: number[] = [];
		const { results, table } = await sendBatch(
			[NOTE, { ...NOTE, path: "b.md", basename: "b" }],
			{},
			deps,
			(done) => progress.push(done),
		);
		expect(results.map((r) => r.ok)).toEqual([false, true]);
		expect(Object.keys(table)).toHaveLength(1);
		expect(progress).toEqual([1, 2]);
	});
});
