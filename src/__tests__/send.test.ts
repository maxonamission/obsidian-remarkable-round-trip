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
			upload: (fileName, bytes) => {
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
			client: { upload: () => Promise.reject(new Error("cloud down")) },
		});
		const { result, table } = await sendNote(NOTE, {}, deps);
		expect(result).toMatchObject({ ok: false, error: "cloud down" });
		expect(table).toEqual({});
	});
});

describe("sendNote output format", () => {
	it("delivers an EPUB with the right extension and format flag", async () => {
		const { deps, uploads } = makeDeps({ format: "epub" });
		const formats: string[] = [];
		deps.client = {
			upload: (fileName, bytes, uploadOptions) => {
				formats.push(uploadOptions.format);
				uploads.push({ fileName, bytes });
				return Promise.resolve({ deviceDocId: "device-1" });
			},
		};
		const { result } = await sendNote(NOTE, {}, deps);
		if (!result.ok) throw new Error("unexpected failure");

		expect(uploads[0].fileName).toBe("Nota.epub");
		expect(formats).toEqual(["epub"]);
		// EPUB is a ZIP: "PK" magic bytes.
		expect(Array.from(uploads[0].bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
	});

	it("records the typography of a PDF upload, so annotations can be anchored", async () => {
		const { deps } = makeDeps({ layout: { fontSize: 13 } });
		const { table } = await sendNote(NOTE, {}, deps);
		// Defaults filled in: reproducing the layout later must not depend on
		// what the settings happen to say then (GP_E3_S8).
		// The typo version rides along (GP_E5_S4-S7): an import replays the
		// typesetter behaviour this upload was laid out with.
		expect(Object.values(table)[0].pdfLayout).toEqual({
			fontSize: 13,
			lineHeight: 1.5,
			margin: 40,
			typo: 5,
			breakAtHeading: 0,
			// The page size rides along too (GP_E6_S2): reproducing the layout
			// later must not depend on which device model is selected then.
			pageWidth: 447,
			pageHeight: 596,
		});
	});

	it("records no typography for EPUB, which has no fixed page layout", async () => {
		const { deps } = makeDeps({ format: "epub" });
		const { table } = await sendNote(NOTE, {}, deps);
		expect(Object.values(table)[0].pdfLayout).toBeUndefined();
	});

	it("defaults to PDF when no format is given", async () => {
		const { deps, uploads } = makeDeps();
		await sendNote(NOTE, {}, deps);
		expect(uploads[0].fileName).toBe("Nota.pdf");
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
			{
				...NOTE,
				content: `${NOTE.content}\nExtra regel.`,
				existingDocId: first.result.docId,
			},
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
			upload: (fileName, bytes, uploadOptions) => {
				uploadArgs.push(uploadOptions.parentId);
				uploads.push({ fileName, bytes });
				return Promise.resolve({ deviceDocId: `device-${uploads.length}` });
			},
		};

		const first = await sendNote(NOTE, {}, deps);
		if (!first.result.ok) throw new Error("unexpected failure");
		const second = await sendNote(
			{
				...NOTE,
				content: `${NOTE.content}\nGewijzigd.`,
				existingDocId: first.result.docId,
			},
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
				upload: () => {
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
