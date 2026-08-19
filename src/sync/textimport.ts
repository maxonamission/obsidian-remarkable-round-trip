/**
 * Write-mode import: the edited text of a notebook back INTO the source
 * note (PRD F17, GP_E7_S3) — the first and only place the plugin replaces
 * a source file instead of adding to one. N5 sets the terms, and this
 * module enforces them structurally:
 *
 * - It runs on an explicit per-note action only (the caller's command).
 * - The previous version is written to a safety-net copy BEFORE the note
 *   is touched, and the outcome names where it went.
 * - A note that changed in the vault after the send is a conflict: the
 *   user chooses — replace (vault version backed up) or keep (device text
 *   saved alongside) — never a silent merge.
 * - Frontmatter never travels (GP_E7_S2), so the note keeps its own.
 *
 * Pure logic over injected adapters, like send.ts: testable without
 * Obsidian or a device.
 */

import { canonicalText } from "../convert/textdoc";
import { DOCID_FRONTMATTER_KEY } from "../id/docid";
import { MappingEntry, contentHash } from "../id/mapping";

export interface DeviceText {
	markdown: string;
	/** True when the page carried no root-text block (pure ink page). */
	missing: boolean;
}

export type ConflictChoice = "replace" | "keep" | "cancel";

export interface TextImportDeps {
	/** The notebook's current text, or null when it is gone from the account. */
	readDeviceText(entry: MappingEntry): Promise<DeviceText | null>;
	/** The note as it is on disk, or null when it cannot be found. */
	readNote(entry: MappingEntry): Promise<string | null>;
	writeNote(entry: MappingEntry, content: string): Promise<void>;
	/** Save the safety-net copy of the note; returns the path written. */
	writeBackup(entry: MappingEntry, content: string): Promise<string>;
	/** Save the device text next to the note (conflict, user keeps the vault
	 * version); returns the path written. */
	writeAside(entry: MappingEntry, markdown: string): Promise<string>;
	/** The note changed in the vault after the send: ask what to do. */
	chooseOnConflict(entry: MappingEntry): Promise<ConflictChoice>;
}

export type TextImportOutcome =
	| { kind: "not-write-mode" }
	| { kind: "not-on-device" }
	| { kind: "no-text" }
	| { kind: "note-missing" }
	| { kind: "unchanged" }
	| { kind: "device-unchanged" }
	| { kind: "imported"; backupPath: string }
	| { kind: "conflict-replaced"; backupPath: string }
	| { kind: "conflict-kept"; asidePath: string }
	| { kind: "cancelled" };

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/** Split a note into its frontmatter block (verbatim) and the body. */
export function splitFrontmatter(content: string): { head: string; body: string } {
	const match = content.match(FRONTMATTER_RE);
	if (!match) return { head: "", body: content };
	return { head: match[0], body: content.slice(match[0].length) };
}

/**
 * Cloud-derived text written at byte 0 of a vault file could open with a
 * frontmatter block of its own — and a crafted `remarkable-id` in it would
 * be a LIVE note identity, hijackable by resolveNote once the real note
 * moves (security-review 2026-08-19). Rename the key so the text stays
 * intact but can never claim to BE a note. Applied wherever device text
 * starts a file: the conflict aside, and a replacement into a note that
 * carries no frontmatter of its own.
 */
export function disarmNoteIdentity(markdown: string): string {
	const { head, body } = splitFrontmatter(markdown);
	if (head === "") return markdown;
	return (
		head.replace(
			new RegExp(`^${DOCID_FRONTMATTER_KEY}(?=\\s*:)`, "gm"),
			`${DOCID_FRONTMATTER_KEY}-imported`,
		) + body
	);
}

/**
 * Import one note's edited text. Returns the outcome plus the mapping
 * entry as it should be stored afterwards (the hashes advance to the
 * imported text, so a follow-up send or import treats the note and the
 * device as in sync).
 */
export async function importEditedText(
	entry: MappingEntry,
	deps: TextImportDeps,
): Promise<{ outcome: TextImportOutcome; entry: MappingEntry }> {
	if (entry.format !== "text") return { outcome: { kind: "not-write-mode" }, entry };

	const device = await deps.readDeviceText(entry);
	if (device === null) return { outcome: { kind: "not-on-device" }, entry };
	if (device.missing) return { outcome: { kind: "no-text" }, entry };

	const current = await deps.readNote(entry);
	if (current === null) return { outcome: { kind: "note-missing" }, entry };
	const { head, body } = splitFrontmatter(current);

	// A note without frontmatter of its own would start with the device
	// text at byte 0 — disarm any identity it carries (see above). The
	// stored hashes and all comparisons follow what would land on disk.
	const incoming = head === "" ? disarmNoteIdentity(device.markdown) : device.markdown;

	// Comparing against the CANONICAL body (one trip through the style
	// subset — `# ` normalises to `## `) is what makes "no difference"
	// reliable, and a second import of the same edits a no-op.
	if (incoming === canonicalText(body)) {
		return { outcome: { kind: "unchanged" }, entry };
	}

	// The device text differs from the note. Three explanations, kept
	// apart deliberately (F14): only the device was edited (import), only
	// the vault changed (nothing to import — the note is newer), or both
	// (a conflict, and the user chooses).
	const vaultChanged = contentHash(body) !== entry.contentHash;
	const deviceEdited =
		entry.textHash === undefined || contentHash(device.markdown) !== entry.textHash;
	const imported: MappingEntry = {
		...entry,
		contentHash: contentHash(incoming),
		textHash: contentHash(device.markdown),
	};

	// No device edits → nothing to import, full stop. This also covers a
	// mapping-rule change between send and import (an 0.36-sent `# Kop`
	// reads back as `## Kop` without anyone touching it): the note is left
	// alone until the device copy is genuinely edited.
	if (!deviceEdited) {
		return { outcome: { kind: "device-unchanged" }, entry };
	}
	if (!vaultChanged) {
		const backupPath = await deps.writeBackup(entry, current);
		await deps.writeNote(entry, head + incoming);
		return { outcome: { kind: "imported", backupPath }, entry: imported };
	}

	switch (await deps.chooseOnConflict(entry)) {
		case "replace": {
			const backupPath = await deps.writeBackup(entry, current);
			await deps.writeNote(entry, head + incoming);
			return { outcome: { kind: "conflict-replaced", backupPath }, entry: imported };
		}
		case "keep": {
			const asidePath = await deps.writeAside(entry, disarmNoteIdentity(device.markdown));
			// The entry does not advance: the note and the device still
			// disagree, and the next import should say so again.
			return { outcome: { kind: "conflict-kept", asidePath }, entry };
		}
		default:
			return { outcome: { kind: "cancelled" }, entry };
	}
}
