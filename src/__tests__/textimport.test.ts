import { describe, expect, it } from "vitest";
import { canonicalText } from "../convert/textdoc";
import { MappingEntry, contentHash } from "../id/mapping";
import {
	ConflictChoice,
	TextImportDeps,
	disarmNoteIdentity,
	importEditedText,
	splitFrontmatter,
} from "../sync/textimport";

const SENT_BODY = "## Doel\nAlles rustig opbouwen.\n- [ ] eerste sessie";
const NOTE = `---\nremarkable-id: 0f8fad5b-d9cb-469f-a165-70867728950e\ntitle: Weeklog\n---\n${SENT_BODY}`;
const EDITED = "## Doel\nAlles rustig opbouwen.\n- [x] eerste sessie\nNieuwe gedachte van het device.";

const ENTRY: MappingEntry = {
	docId: "0f8fad5b-d9cb-469f-a165-70867728950e",
	notePath: "map/Weeklog.md",
	deviceDocId: "device-1",
	uploadedAt: "2026-08-19T17:00:00Z",
	contentHash: contentHash(SENT_BODY),
	format: "text",
	textHash: contentHash(canonicalText(SENT_BODY)),
};

function makeDeps(overrides: Partial<TextImportDeps> = {}) {
	const written: string[] = [];
	const backups: string[] = [];
	const asides: string[] = [];
	const deps: TextImportDeps = {
		readDeviceText: () => Promise.resolve({ markdown: EDITED, missing: false }),
		readNote: () => Promise.resolve(NOTE),
		writeNote: (_entry, content) => {
			written.push(content);
			return Promise.resolve();
		},
		writeBackup: (_entry, content) => {
			backups.push(content);
			return Promise.resolve("reMarkable-in/previous/Weeklog (0f8fad5b).md");
		},
		writeAside: (_entry, markdown) => {
			asides.push(markdown);
			return Promise.resolve("map/Weeklog (from reMarkable).md");
		},
		chooseOnConflict: () => Promise.resolve("cancel" as ConflictChoice),
		...overrides,
	};
	return { deps, written, backups, asides };
}

describe("splitFrontmatter", () => {
	it("keeps the frontmatter block verbatim and returns the body", () => {
		const { head, body } = splitFrontmatter(NOTE);
		expect(head.startsWith("---\n")).toBe(true);
		expect(head.endsWith("---\n")).toBe(true);
		expect(body).toBe(SENT_BODY);
		expect(head + body).toBe(NOTE);
	});

	it("treats a note without frontmatter as all body", () => {
		expect(splitFrontmatter("gewoon tekst")).toEqual({ head: "", body: "gewoon tekst" });
	});
});

describe("importEditedText (GP_E7_S3)", () => {
	it("backs up first, then replaces the body and keeps the frontmatter", async () => {
		const { deps, written, backups } = makeDeps();
		const { outcome, entry } = await importEditedText(ENTRY, deps);

		expect(outcome).toEqual({
			kind: "imported",
			backupPath: "reMarkable-in/previous/Weeklog (0f8fad5b).md",
		});
		// The safety net holds the FULL previous note, frontmatter included.
		expect(backups).toEqual([NOTE]);
		expect(written).toHaveLength(1);
		expect(written[0].startsWith("---\nremarkable-id:")).toBe(true);
		expect(written[0].endsWith(EDITED)).toBe(true);
		// The hashes advance: note and device now agree.
		expect(entry.contentHash).toBe(contentHash(EDITED));
		expect(entry.textHash).toBe(contentHash(EDITED));
	});

	it("does nothing when the device text matches the note (canonically)", async () => {
		const { deps, written, backups } = makeDeps({
			readDeviceText: () =>
				Promise.resolve({ markdown: canonicalText(SENT_BODY), missing: false }),
		});
		const { outcome, entry } = await importEditedText(ENTRY, deps);
		expect(outcome).toEqual({ kind: "unchanged" });
		expect(written).toHaveLength(0);
		expect(backups).toHaveLength(0);
		expect(entry).toBe(ENTRY);
	});

	it("treats the canonical round-trip of a `# ` note as no edit", async () => {
		// Since GP_E7_S4 the subset maps only `## ` (the device's single
		// heading level); `# Kop` travels literal and the canonical form is
		// the identity — so an unedited copy can never look like an edit.
		const body = "# Kop\ninhoud";
		const note = `---\na: b\n---\n${body}`;
		const { deps, written } = makeDeps({
			readNote: () => Promise.resolve(note),
			readDeviceText: () => Promise.resolve({ markdown: canonicalText(body), missing: false }),
		});
		const entry = {
			...ENTRY,
			contentHash: contentHash(body),
			textHash: contentHash(canonicalText(body)),
		};
		const { outcome } = await importEditedText(entry, deps);
		expect(outcome).toEqual({ kind: "unchanged" });
		expect(written).toHaveLength(0);
	});

	it("leaves an unedited 0.36-mapping document alone after the rules changed", async () => {
		// Sent when `# ` still mapped to the heading style: the device reads
		// back "## Kop" without anyone touching it. textHash proves the device
		// was never edited, so nothing is imported — the note waits for a real
		// edit (or a re-send under the new rules).
		const body = "# Kop\ninhoud";
		const oldCanonical = "## Kop\ninhoud";
		const { deps, written } = makeDeps({
			readNote: () => Promise.resolve(`---\na: b\n---\n${body}`),
			readDeviceText: () => Promise.resolve({ markdown: oldCanonical, missing: false }),
		});
		const entry = {
			...ENTRY,
			contentHash: contentHash(body),
			textHash: contentHash(oldCanonical),
		};
		const { outcome } = await importEditedText(entry, deps);
		expect(outcome).toEqual({ kind: "device-unchanged" });
		expect(written).toHaveLength(0);
	});

	it("reports 'the note is newer' when only the vault changed", async () => {
		const { deps, written } = makeDeps({
			readNote: () => Promise.resolve(`---\na: b\n---\nheel andere inhoud`),
			readDeviceText: () =>
				Promise.resolve({ markdown: canonicalText(SENT_BODY), missing: false }),
		});
		const { outcome, entry } = await importEditedText(ENTRY, deps);
		expect(outcome).toEqual({ kind: "device-unchanged" });
		expect(written).toHaveLength(0);
		expect(entry).toBe(ENTRY);
	});

	it("asks on a true conflict and replaces (with backup) when told to", async () => {
		const conflictedNote = `---\na: b\n---\nvault ging verder na de verzending`;
		const { deps, written, backups } = makeDeps({
			readNote: () => Promise.resolve(conflictedNote),
			chooseOnConflict: () => Promise.resolve("replace" as ConflictChoice),
		});
		const { outcome, entry } = await importEditedText(ENTRY, deps);
		expect(outcome).toMatchObject({ kind: "conflict-replaced" });
		expect(backups).toEqual([conflictedNote]);
		expect(written[0].endsWith(EDITED)).toBe(true);
		expect(entry.contentHash).toBe(contentHash(EDITED));
	});

	it("keeps the note and saves the device text alongside when told to", async () => {
		const { deps, written, asides } = makeDeps({
			readNote: () => Promise.resolve(`---\na: b\n---\nvault ging verder`),
			chooseOnConflict: () => Promise.resolve("keep" as ConflictChoice),
		});
		const { outcome, entry } = await importEditedText(ENTRY, deps);
		expect(outcome).toEqual({
			kind: "conflict-kept",
			asidePath: "map/Weeklog (from reMarkable).md",
		});
		expect(written).toHaveLength(0);
		expect(asides).toEqual([EDITED]);
		// Not advanced: the next import must surface the same disagreement.
		expect(entry).toBe(ENTRY);
	});

	it("cancelling a conflict touches nothing", async () => {
		const { deps, written, backups, asides } = makeDeps({
			readNote: () => Promise.resolve(`---\na: b\n---\nvault ging verder`),
		});
		const { outcome } = await importEditedText(ENTRY, deps);
		expect(outcome).toEqual({ kind: "cancelled" });
		expect(written.length + backups.length + asides.length).toBe(0);
	});

	it("degrades a 0.36.0 entry (no textHash) to the conflict ask", async () => {
		// Without the canonical hash we cannot prove the device was never
		// edited, so a changed vault falls back to asking — never to silence.
		const legacy = { ...ENTRY, textHash: undefined };
		let asked = 0;
		const { deps } = makeDeps({
			readNote: () => Promise.resolve(`---\na: b\n---\nheel andere inhoud`),
			readDeviceText: () =>
				Promise.resolve({ markdown: canonicalText(SENT_BODY), missing: false }),
			chooseOnConflict: () => {
				asked++;
				return Promise.resolve("cancel" as ConflictChoice);
			},
		});
		const { outcome } = await importEditedText(legacy, deps);
		expect(asked).toBe(1);
		expect(outcome).toEqual({ kind: "cancelled" });
	});

	it("disarms a note identity smuggled in device text (security-review)", () => {
		// Device text is cloud-controlled; a leading frontmatter block with a
		// remarkable-id would be a LIVE identity in the vault, hijackable by
		// the docId lookup once the real note moves. The key is renamed, the
		// text otherwise untouched.
		const armed = "---\nremarkable-id: 11111111-2222-3333-4444-555555555555\n---\ntekst";
		expect(disarmNoteIdentity(armed)).toBe(
			"---\nremarkable-id-imported: 11111111-2222-3333-4444-555555555555\n---\ntekst",
		);
		// No leading frontmatter, or `---` further down: nothing to disarm.
		expect(disarmNoteIdentity("gewoon\n---\nremarkable-id: x\n---")).toBe(
			"gewoon\n---\nremarkable-id: x\n---",
		);
	});

	it("writes the conflict aside with any smuggled identity disarmed", async () => {
		const armed = "---\nremarkable-id: 11111111-2222-3333-4444-555555555555\n---\nboze tekst";
		const { deps, asides } = makeDeps({
			readNote: () => Promise.resolve(`---\na: b\n---\nvault ging verder`),
			readDeviceText: () => Promise.resolve({ markdown: armed, missing: false }),
			chooseOnConflict: () => Promise.resolve("keep" as ConflictChoice),
		});
		await importEditedText(ENTRY, deps);
		expect(asides).toHaveLength(1);
		expect(asides[0]).toContain("remarkable-id-imported:");
		expect(asides[0]).not.toMatch(/^remarkable-id:/m);
	});

	it("disarms device text replacing a note that has no frontmatter of its own", async () => {
		const armed = "---\nremarkable-id: 11111111-2222-3333-4444-555555555555\n---\nnieuw";
		const body = "oude tekst zonder frontmatter";
		const { deps, written } = makeDeps({
			readNote: () => Promise.resolve(body),
			readDeviceText: () => Promise.resolve({ markdown: armed, missing: false }),
		});
		const entry = {
			...ENTRY,
			contentHash: contentHash(body),
			textHash: contentHash(canonicalText(body)),
		};
		const { outcome, entry: updated } = await importEditedText(entry, deps);
		expect(outcome).toMatchObject({ kind: "imported" });
		expect(written[0].startsWith("---\nremarkable-id-imported:")).toBe(true);
		// The stored hash follows what landed on disk, so a second import of
		// the same device text is a no-op instead of a rewrite loop.
		expect(updated.contentHash).toBe(contentHash(written[0]));
	});

	it("refuses non-write-mode entries and reports device states honestly", async () => {
		const { deps } = makeDeps();
		expect(
			(await importEditedText({ ...ENTRY, format: "pdf" }, deps)).outcome,
		).toEqual({ kind: "not-write-mode" });
		expect(
			(
				await importEditedText(ENTRY, {
					...deps,
					readDeviceText: () => Promise.resolve(null),
				})
			).outcome,
		).toEqual({ kind: "not-on-device" });
		expect(
			(
				await importEditedText(ENTRY, {
					...deps,
					readDeviceText: () => Promise.resolve({ markdown: "", missing: true }),
				})
			).outcome,
		).toEqual({ kind: "no-text" });
		expect(
			(
				await importEditedText(ENTRY, { ...deps, readNote: () => Promise.resolve(null) })
			).outcome,
		).toEqual({ kind: "note-missing" });
	});
});
