import { describe, expect, it } from "vitest";
import {
	RawEntry,
	RawSyncApi,
	readTextNotebook,
	sendTextNotebook,
	uploadTextNotebook,
} from "../transport/textnotebook";
import { markdownFromParagraphs, paragraphsFromMarkdown } from "../convert/textdoc";
import { PARAGRAPH_STYLE } from "../convert/rmtext";

const MD = [
	"## Uitvoering",
	"**Krachtblok — trekken**",
	"Horizontale trekbeweging met een elastiek.",
	"- Ellebogen langs het lichaam",
	"- [ ] elastiek controleren",
	"- [x] 2 × 15 gedaan",
	"gewone [[wikilink]] blijft letterlijk staan",
].join("\n");

describe("markdown ↔ device paragraphs (F18 subset)", () => {
	it("maps the style subset both ways without loss", () => {
		const paragraphs = paragraphsFromMarkdown(MD);
		expect(paragraphs.map((p) => p.style)).toEqual([
			PARAGRAPH_STYLE.heading,
			PARAGRAPH_STYLE.bold,
			PARAGRAPH_STYLE.plain,
			PARAGRAPH_STYLE.bullet,
			PARAGRAPH_STYLE.checkbox,
			PARAGRAPH_STYLE.checkboxChecked,
			PARAGRAPH_STYLE.plain,
		]);
		// The round-trip: # becomes ## (single mapping), the rest is exact.
		expect(markdownFromParagraphs(paragraphs)).toBe(MD);
	});

	it("keeps markdown outside the subset as literal text (F17: no silent loss)", () => {
		const literal = "een *cursief* woord en een [[link|alias]] en `code`";
		const [paragraph] = paragraphsFromMarkdown(literal);
		expect(paragraph).toEqual({ text: literal, style: PARAGRAPH_STYLE.plain });
		expect(markdownFromParagraphs([paragraph])).toBe(literal);
	});
});

/** In-memory raw api: content-addressed puts, root hash, entry lists. */
function fakeApi(options: { failRootHashTimes?: number } = {}): {
	api: RawSyncApi;
	log: string[];
	rootList: () => RawEntry[];
	texts: Map<string, string>;
} {
	const files = new Map<string, Uint8Array>();
	const texts = new Map<string, string>();
	const lists = new Map<string, RawEntry[]>();
	let root: RawEntry | null = null;
	let generation = 1;
	let rootHashFailures = options.failRootHashTimes ?? 0;
	const log: string[] = [];
	let counter = 0;
	const entry = (id: string): RawEntry => ({ id, hash: `h${++counter}` });

	const api: RawSyncApi = {
		getRootHash: () => {
			log.push("getRootHash");
			return Promise.resolve([root?.hash ?? "root0", generation, 3]);
		},
		getEntries: (id, hash) => {
			log.push(`getEntries ${id}`);
			return Promise.resolve({ entries: lists.get(hash) ?? [] });
		},
		getHash: (id, hash) => {
			log.push(`getHash ${id}`);
			const bytes = files.get(hash);
			if (!bytes) throw new Error(`no file for ${hash}`);
			return Promise.resolve(bytes);
		},
		putFile: (id, bytes) => {
			log.push(`putFile ${id}`);
			const e = entry(id);
			files.set(e.hash, bytes);
			return Promise.resolve([e, Promise.resolve()]);
		},
		putText: (id, content) => {
			log.push(`putText ${id}`);
			const e = entry(id);
			files.set(e.hash, new TextEncoder().encode(content));
			texts.set(id, content);
			return Promise.resolve([e, Promise.resolve()]);
		},
		putEntries: (id, entries, _schema) => {
			log.push(`putEntries ${id}`);
			const e = entry(id);
			lists.set(e.hash, [...entries]);
			return Promise.resolve([e, Promise.resolve()]);
		},
		putRootHash: (hash, gen) => {
			log.push("putRootHash");
			if (rootHashFailures > 0) {
				rootHashFailures--;
				return Promise.reject(new Error("precondition failed"));
			}
			expect(gen).toBe(generation);
			root = { id: "root", hash };
			generation++;
			return Promise.resolve([hash, generation]);
		},
	};
	return { api, log, rootList: () => (root ? (lists.get(root.hash) ?? []) : []), texts };
}

describe("notebook upload + read-back (GP_E7_S2, uit spike GP_E7_S1)", () => {
	it("uploads the full bundle in rmapi-js' order and reads the text back", async () => {
		const { api, log } = fakeApi();
		const { docId, pageId } = await uploadTextNotebook(api, "Weeklog", MD, {
			now: () => 1755093600000,
		});

		// The bundle: content, metadata, pagedata, one page .rm, one entries
		// list for the doc, a new root list, then the root hash swap.
		expect(log.filter((l) => l.startsWith("putText"))).toHaveLength(3);
		expect(log).toContain(`putFile ${docId}/${pageId}.rm`);
		expect(log).toContain(`putEntries ${docId}`);
		expect(log).toContain("putEntries root");
		expect(log[log.length - 1]).toBe("putRootHash");

		const result = await readTextNotebook(api, docId);
		expect(result.missing).toBe(false);
		expect(result.markdown).toBe(MD);
		expect(result.paragraphCount).toBe(7);
	});

	it("writes content rmapi-js' reader accepts: fileType notebook (device-bevinding)", async () => {
		// 2026-08-19: fileType "" validated in NO branch of rmapi-js' content
		// union, so every listItems — folder mirroring included — crashed on
		// the spike document the moment it existed in the account.
		const { api, texts } = fakeApi();
		const { docId } = await uploadTextNotebook(api, "Weeklog", MD, {
			now: () => 1755093600000,
		});
		const content = JSON.parse(texts.get(`${docId}.content`) ?? "{}") as {
			fileType?: string;
		};
		expect(content.fileType).toBe("notebook");
	});

	it("files the notebook under the given collection (folder mirroring)", async () => {
		const { api, texts } = fakeApi();
		const { docId } = await uploadTextNotebook(api, "Weeklog", MD, {
			parentId: "collection-42",
			now: () => 1755093600000,
		});
		const metadata = JSON.parse(texts.get(`${docId}.metadata`) ?? "{}") as {
			parent?: string;
			visibleName?: string;
		};
		expect(metadata.parent).toBe("collection-42");
		expect(metadata.visibleName).toBe("Weeklog");
	});

	it("re-uploading the same docId replaces the root entry, never duplicates", async () => {
		const { api, rootList } = fakeApi();
		const fixed = { docId: "doc-1", pageId: "page-1", now: () => 1755093600000 };
		await uploadTextNotebook(api, "Weeklog", MD, fixed);
		await uploadTextNotebook(api, "Weeklog", `${MD}\nextra regel`, fixed);
		expect(rootList().filter((entry) => entry.id === "doc-1")).toHaveLength(1);
		const result = await readTextNotebook(api, "doc-1");
		expect(result.markdown).toContain("extra regel");
	});

	it("fails loudly when the notebook is gone from the account", async () => {
		const { api } = fakeApi();
		await expect(readTextNotebook(api, "bestaat-niet")).rejects.toThrow(/not found/);
	});
});

describe("sendTextNotebook: production retry (N3)", () => {
	it("retries a generation conflict and keeps one document", async () => {
		const { api, log, rootList } = fakeApi({ failRootHashTimes: 1 });
		const result = await sendTextNotebook(api, "Weeklog", MD, {
			retry: { sleep: () => Promise.resolve() },
			now: () => 1755093600000,
		});
		expect(log.filter((l) => l === "putRootHash")).toHaveLength(2);
		expect(rootList().filter((entry) => entry.id === result.deviceDocId)).toHaveLength(1);
	});

	it("gives up on a non-conflict error without retrying", async () => {
		const { api, log } = fakeApi();
		const failing: RawSyncApi = {
			...api,
			putFile: () => Promise.reject(new Error("disk on fire")),
		};
		await expect(
			sendTextNotebook(failing, "Weeklog", MD, {
				retry: { sleep: () => Promise.resolve() },
			}),
		).rejects.toThrow(/disk on fire/);
		expect(log.filter((l) => l === "putRootHash")).toHaveLength(0);
	});
});
