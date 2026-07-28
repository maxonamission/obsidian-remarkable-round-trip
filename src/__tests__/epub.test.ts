import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parseBlocks } from "../convert/mdblocks";
import { escapeXml, renderBody, renderEpub } from "../convert/epub";

const META = {
	title: "Testnotitie",
	docId: "0f8fad5b-d9cb-469f-a165-70867728950e",
	modified: "2026-07-25T12:00:00Z",
};

async function openEpub(bytes: Uint8Array) {
	const zip = await JSZip.loadAsync(bytes);
	const read = async (path: string) => {
		const file = zip.file(path);
		if (!file) throw new Error(`ontbrekend bestand in EPUB: ${path}`);
		return file.async("string");
	};
	return { zip, read };
}

describe("escapeXml", () => {
	it("escapes the characters that would break XHTML", () => {
		expect(escapeXml(`a & b < c > d " e ' f`)).toBe(
			"a &amp; b &lt; c &gt; d &quot; e &apos; f",
		);
	});
});

describe("renderBody", () => {
	it("renders every block type as XHTML", () => {
		const md = [
			"# Kop",
			"Alinea.",
			"- een\n- twee",
			"1. eerste",
			"> citaat",
			"```\ncode\n```",
			"| a | b |\n|---|---|\n| 1 | 2 |",
			"---",
		].join("\n\n");
		const { xhtml } = renderBody(parseBlocks(md));
		expect(xhtml).toContain("<h1 ");
		expect(xhtml).toContain("<p>Alinea.</p>");
		expect(xhtml).toContain("<ul><li>een</li><li>twee</li></ul>");
		expect(xhtml).toContain("<ol><li>eerste</li></ol>");
		expect(xhtml).toContain("<blockquote><p>citaat</p></blockquote>");
		expect(xhtml).toContain("<pre><code>code</code></pre>");
		expect(xhtml).toContain("<th>a</th>");
		expect(xhtml).toContain("<td>1</td>");
		expect(xhtml).toContain("<hr/>");
	});

	it("nests sub-lists instead of flattening them", () => {
		const { xhtml } = renderBody(parseBlocks("- een\n  - sub\n- twee"));
		expect(xhtml).toBe("<ul><li>een</li><ul><li>sub</li></ul><li>twee</li></ul>");
	});

	it("builds a table of contents from the headings, with unique ids", () => {
		const { toc, xhtml } = renderBody(parseBlocks("# Eerste\n\n## Tweede\n\n## Tweede"));
		expect(toc.map((e) => e.text)).toEqual(["Eerste", "Tweede", "Tweede"]);
		expect(new Set(toc.map((e) => e.id)).size).toBe(3);
		for (const entry of toc) expect(xhtml).toContain(`id="${entry.id}"`);
	});

	it("escapes content that would otherwise break the document", () => {
		const { xhtml } = renderBody(parseBlocks("Kosten < 5 & meer"));
		expect(xhtml).toContain("Kosten &lt; 5 &amp; meer");
	});
});

describe("renderEpub", () => {
	it("produces a valid EPUB container", async () => {
		const bytes = await renderEpub(parseBlocks("Tekst."), META);
		const { zip, read } = await openEpub(bytes);

		// mimetype must be the first entry and stored uncompressed.
		const names = Object.keys(zip.files);
		expect(names[0]).toBe("mimetype");
		expect(await read("mimetype")).toBe("application/epub+zip");

		const container = await read("META-INF/container.xml");
		expect(container).toContain('full-path="EPUB/package.opf"');

		const pkg = await read("EPUB/package.opf");
		expect(pkg).toContain(`urn:uuid:${META.docId}`);
		expect(pkg).toContain("<dc:title>Testnotitie</dc:title>");
		expect(pkg).toContain('<meta property="dcterms:modified">2026-07-25T12:00:00Z</meta>');
		expect(pkg).toContain('properties="nav"');

		const content = await read("EPUB/content.xhtml");
		expect(content).toContain("<h1>Testnotitie</h1>");
		expect(content).toContain("<p>Tekst.</p>");
	});

	it("lists the headings in the navigation document", async () => {
		const bytes = await renderEpub(parseBlocks("## Hoofdstuk een\n\ntekst"), META);
		const { read } = await openEpub(bytes);
		const nav = await read("EPUB/nav.xhtml");
		expect(nav).toContain('epub:type="toc"');
		expect(nav).toContain("Hoofdstuk een");
		expect(nav).toContain('href="content.xhtml#');
	});

	it("falls back to a title entry when the note has no headings", async () => {
		const bytes = await renderEpub(parseBlocks("Alleen tekst."), META);
		const { read } = await openEpub(bytes);
		const nav = await read("EPUB/nav.xhtml");
		expect(nav).toContain('<a href="content.xhtml">Testnotitie</a>');
	});

	it("keeps non-Latin text intact (where the PDF path falls back to ASCII)", async () => {
		const bytes = await renderEpub(parseBlocks("日本語 en Ελληνικά"), META);
		const { read } = await openEpub(bytes);
		expect(await read("EPUB/content.xhtml")).toContain("日本語 en Ελληνικά");
	});
});

describe("the archive itself", () => {
	it("stores mimetype first and uncompressed, as the EPUB spec requires", async () => {
		// GP_E3_S21: written by hand since JSZip left a setImmediate polyfill in
		// the bundle whose IE-era fallbacks create <script> elements.
		const bytes = await renderEpub(parseBlocks("Tekst."), META);
		const head = new TextDecoder("latin1").decode(bytes.subarray(0, 60));
		expect(head.slice(30, 38)).toBe("mimetype");
		expect(head.slice(38, 58)).toBe("application/epub+zip");
		// Compression method (offset 8) is 0 = stored.
		expect(new DataView(bytes.buffer).getUint16(8, true)).toBe(0);
	});

	it("produces the same bytes twice, so an unchanged note stays unchanged", async () => {
		const first = await renderEpub(parseBlocks("Tekst."), META);
		const second = await renderEpub(parseBlocks("Tekst."), META);
		expect(Array.from(first)).toEqual(Array.from(second));
	});

	it("survives non-ASCII content and file names intact", async () => {
		const bytes = await renderEpub(parseBlocks("Ze vertellen niet wáárom — lid worden."), META);
		const zip = await JSZip.loadAsync(bytes);
		const text = await zip.file("EPUB/content.xhtml")!.async("string");
		expect(text).toContain("wáárom — lid worden");
	});
});
