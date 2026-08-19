import { describe, expect, it } from "vitest";
import {
	SpikeEntry,
	SpikeRawApi,
	markdownFromParagraphs,
	paragraphsFromMarkdown,
	readTextNotebook,
	uploadTextNotebook,
} from "../spike/writemode";
import { PARAGRAPH_STYLE } from "../spike/rmtext";

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
function fakeApi(): { api: SpikeRawApi; log: string[] } {
	const files = new Map<string, Uint8Array>();
	const lists = new Map<string, SpikeEntry[]>();
	let root: SpikeEntry | null = null;
	let generation = 1;
	const log: string[] = [];
	let counter = 0;
	const entry = (id: string): SpikeEntry => ({ id, hash: `h${++counter}` });

	const api: SpikeRawApi = {
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
			expect(gen).toBe(generation);
			root = { id: "root", hash };
			generation++;
			return Promise.resolve([hash, generation]);
		},
	};
	return { api, log };
}

describe("spike notebook upload + read-back (aannames 1 en 3)", () => {
	it("uploads the full bundle in rmapi-js' order and reads the text back", async () => {
		const { api, log } = fakeApi();
		const { docId, pageId } = await uploadTextNotebook(api, "Spike", MD, () => 1755093600000);

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
		const { api, log } = fakeApi();
		const put: string[] = [];
		const spy: typeof api.putText = (id, content) => {
			put.push(content);
			return api.putText(id, content);
		};
		await uploadTextNotebook({ ...api, putText: spy }, "Spike", MD, () => 1755093600000);
		const content = JSON.parse(put.find((c) => c.includes("fileType")) ?? "{}") as {
			fileType?: string;
		};
		expect(content.fileType).toBe("notebook");
		expect(log.length).toBeGreaterThan(0);
	});

	it("fails loudly when the notebook is gone from the account", async () => {
		const { api } = fakeApi();
		await expect(readTextNotebook(api, "bestaat-niet")).rejects.toThrow(/not found/);
	});
});
