import { beforeAll, describe, expect, it } from "vitest";
import { parseBlocks } from "../convert/mdblocks";
import { PdfLayout, renderPdf } from "../convert/pdf";
import { preprocess } from "../preprocess/preprocess";
import { projectOntoSource } from "../incoming/sourceprojection";
import type { ImportedMark } from "../incoming/pull";

/** A note with the formatting the first annotated copy used to lose. */
const SOURCE = [
	"**Data belooft zekerheid in een onzekere wereld.**",
	"",
	"## De beperkte blik",
	"",
	"Neem die groeiende ledencijfers. Ze vertellen niet waarom mensen lid worden – ",
	"of ze tevreden zijn.",
	"",
	"### Investeer in analyse bij:",
	"- **Grote financiële beslissingen** – waar je inschatting jaren doorwerkt",
	"- **Strategische koerswijzigingen** – die de hele organisatie raken",
	"",
	"*Reactie: \"Precies. Daarom combineren we cijfers met gesprekken.\"*",
].join("\n");

let layout: PdfLayout;

beforeAll(async () => {
	const pre = preprocess(SOURCE, { resolveEmbed: () => ({ kind: "missing" }) });
	const rendered = await renderPdf(parseBlocks(pre.markdown), {
		title: "Artikel datagedreven organiseren",
		docId: "d",
	});
	layout = rendered.layout;
});

/** Ids of the layout words making up a phrase, as the typesetter placed them. */
function idsOf(phrase: string): number[] {
	const wanted = phrase.split(" ");
	const words = layout.lines.flatMap((line) => line.words);
	for (let at = 0; at + wanted.length <= words.length; at++) {
		const run = words.slice(at, at + wanted.length);
		if (run.every((word, i) => word.text === wanted[i])) return run.map((word) => word.id);
	}
	throw new Error(`phrase not laid out: ${phrase}`);
}

function blockOf(phrase: string): number {
	const line = layout.lines.find((candidate) => candidate.text.includes(phrase));
	if (line === undefined) throw new Error(`phrase not laid out: ${phrase}`);
	return line.block;
}

const project = (
	marks: ImportedMark[],
	highlights: Parameters<typeof projectOntoSource>[0]["highlights"] = [],
) => projectOntoSource({ source: SOURCE, layout, marks, highlights });

describe("projectOntoSource", () => {
	it("keeps the note exactly as it is when nothing was marked", () => {
		expect(project([])?.markdown).toBe(SOURCE.trimEnd());
	});

	it("keeps bold, italics, heading levels and en dashes", () => {
		const out = project([{ kind: "circle", page: 1, words: idsOf("groeiende ledencijfers.") }])
			?.markdown;
		expect(out).toContain("**Data belooft zekerheid in een onzekere wereld.**");
		expect(out).toContain("## De beperkte blik");
		expect(out).toContain("– waar je inschatting jaren doorwerkt");
		expect(out).toContain('*Reactie: "Precies.');
	});

	it("marks the words the pen covered, inside the surrounding markdown", () => {
		const out = project([
			{ kind: "strikethrough", page: 1, words: idsOf("of ze tevreden") },
		])?.markdown;
		expect(out).toContain("~~of ze tevreden~~ zijn.");
	});

	it("reaches words that sit inside bold markup", () => {
		// The layout word is "Grote"; the source has "**Grote financiële …**".
		const out = project([{ kind: "underline", page: 1, words: idsOf("Grote financiële") }])
			?.markdown;
		expect(out).toContain("<u>Grote financiële</u>");
		expect(out).toContain("**<u>Grote financiële</u> beslissingen**");
	});

	it("merges two marks of the same kind instead of doubling the markup", () => {
		// Beta 2026-07-27: overlapping strike-throughs produced `~~~~`, which
		// markdown reads as nothing at all.
		const out = project([
			{ kind: "strikethrough", page: 1, words: idsOf("Ze vertellen niet") },
			{ kind: "strikethrough", page: 1, words: idsOf("niet waarom mensen") },
		])?.markdown;
		expect(out).not.toContain("~~~~");
		expect(out).toContain("~~Ze vertellen niet waarom mensen~~");
	});

	it("gives a highlight its colour", () => {
		const out = project([], [
			{ text: "Ze vertellen niet waarom mensen", color: 1, page: 1 },
		])?.markdown;
		expect(out).toContain(
			'<mark style="background: #a5d8ff">Ze vertellen niet waarom mensen</mark>',
		);
	});

	it("quotes the lines a margin bar ran alongside", () => {
		const out = project([
			{ kind: "margin", page: 1, blocks: [blockOf("Neem die groeiende")] },
		])?.markdown;
		expect(out).toContain("> Neem die groeiende ledencijfers.");
	});

	it("puts a remark under the line it was written against", () => {
		const out = project([
			{
				kind: "note",
				page: 1,
				quote: "Neem die groeiende ledencijfers. Ze vertellen niet waarom mensen lid",
				path: "img/dev-p01-1.png",
			},
		])?.markdown;
		const lines = out?.split("\n") ?? [];
		const text = lines.findIndex((line) => line.includes("Neem die groeiende"));
		const remark = lines.findIndex((line) => line.includes("[!note] Remark"));
		expect(remark).toBeGreaterThan(text);
		expect(out).toContain("> ![[img/dev-p01-1.png]]");
	});

	it("keeps a highlight it cannot find, rather than dropping it", () => {
		const result = project([], [{ text: "staat niet in deze notitie", page: 1 }]);
		expect(result?.unplaced).toHaveLength(1);
		expect(result?.markdown).toContain("could not be placed");
	});

	it("is not thrown off by the title the plugin puts on the document", async () => {
		// Beta 2026-07-27: the typeset document opens with a title the note
		// itself does not carry. Its words ("blik", "analyse") occur further
		// down the note, so a title word matched there and dragged the cursor
		// past everything above it — after which nothing lined up and the
		// projection refused, silently falling back to the old summary.
		const pre = preprocess(SOURCE, { resolveEmbed: () => ({ kind: "missing" }) });
		const titled = await renderPdf(parseBlocks(pre.markdown), {
			title: "Analyse van de beperkte blik",
			docId: "d",
		});

		const result = projectOntoSource({
			source: SOURCE,
			layout: titled.layout,
			marks: [],
			highlights: [],
		});
		expect(result).not.toBeNull();
		expect(result?.markdown).toBe(SOURCE.trimEnd());
	});

	it("refuses to project onto a note that is not the same document", () => {
		expect(
			projectOntoSource({
				source: "Een heel andere tekst zonder enige overlap qua woorden.",
				layout,
				marks: [],
				highlights: [],
			}),
		).toBeNull();
	});
});
