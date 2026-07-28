/**
 * Markdown blocks → EPUB 3 (PRD F3 secondary format, open question 4).
 *
 * Why EPUB exists next to PDF: reflowable text reads more comfortably on
 * e-ink (the device picks font size and pagination), and the content is
 * UTF-8 so scripts outside Latin-1 survive — the PDF path falls back to
 * ASCII there. The trade-off is annotation anchoring: the reMarkable
 * repaginates an EPUB, so page-level annotation mapping is fragile. PDF
 * therefore stays the default for anything you intend to annotate (K2).
 *
 * Pure JS/TS, so the same path runs on mobile (N7).
 */

import { zipStore } from "./zip";
import type { Block, ListItem } from "./mdblocks";

export interface EpubMetadata {
	title: string;
	/** Stable document ID (F5); becomes the publication's dc:identifier. */
	docId: string;
	/** BCP-47 language tag for the publication. */
	language?: string;
	/** UTC timestamp for dcterms:modified; defaults to now. */
	modified?: string;
}

const CONTAINER_PATH = "META-INF/container.xml";
const PACKAGE_PATH = "EPUB/package.opf";
const CONTENT_PATH = "EPUB/content.xhtml";
const NAV_PATH = "EPUB/nav.xhtml";

export function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Stable, unique, XML-safe id for a heading anchor. */
function headingId(text: string, index: number): string {
	const slug = text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `h${index}${slug === "" ? "" : `-${slug}`}`;
}

interface RenderedBody {
	xhtml: string;
	toc: { id: string; level: number; text: string }[];
}

function renderList(items: ListItem[]): string {
	// Rebuild nesting from the flat depth markers the parser produces.
	let out = "";
	const stack: boolean[] = []; // true = ordered, per open level

	const open = (ordered: boolean) => {
		out += ordered ? "<ol>" : "<ul>";
		stack.push(ordered);
	};
	const close = () => {
		out += stack.pop() ? "</ol>" : "</ul>";
	};

	for (const item of items) {
		const depth = item.depth;
		while (stack.length > depth + 1) close();
		if (stack.length === 0) open(item.ordered);
		while (stack.length < depth + 1) open(item.ordered);
		out += `<li>${escapeXml(item.text)}</li>`;
	}
	while (stack.length > 0) close();
	return out;
}

function renderTable(rows: string[][]): string {
	const [header, ...body] = rows;
	const head =
		header === undefined
			? ""
			: `<thead><tr>${header.map((c) => `<th>${escapeXml(c)}</th>`).join("")}</tr></thead>`;
	const cells = body
		.map((row) => `<tr>${row.map((c) => `<td>${escapeXml(c)}</td>`).join("")}</tr>`)
		.join("");
	return `<table>${head}<tbody>${cells}</tbody></table>`;
}

export function renderBody(blocks: Block[]): RenderedBody {
	const parts: string[] = [];
	const toc: RenderedBody["toc"] = [];
	let headingIndex = 0;

	for (const block of blocks) {
		switch (block.type) {
			case "heading": {
				const level = Math.min(Math.max(block.level, 1), 6);
				const id = headingId(block.text, headingIndex++);
				toc.push({ id, level, text: block.text });
				parts.push(`<h${level} id="${id}">${escapeXml(block.text)}</h${level}>`);
				break;
			}
			case "paragraph":
				parts.push(`<p>${escapeXml(block.text)}</p>`);
				break;
			case "list":
				parts.push(renderList(block.items));
				break;
			case "quote":
				parts.push(
					`<blockquote>${block.lines.map((l) => `<p>${escapeXml(l)}</p>`).join("")}</blockquote>`,
				);
				break;
			case "code":
				parts.push(`<pre><code>${escapeXml(block.lines.join("\n"))}</code></pre>`);
				break;
			case "table":
				parts.push(renderTable(block.rows));
				break;
			case "hr":
				parts.push("<hr/>");
				break;
		}
	}
	return { xhtml: parts.join("\n"), toc };
}

function contentDocument(meta: EpubMetadata, body: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(meta.language ?? "en")}" lang="${escapeXml(meta.language ?? "en")}">
<head><meta charset="utf-8"/><title>${escapeXml(meta.title)}</title></head>
<body>
<h1>${escapeXml(meta.title)}</h1>
${body}
</body>
</html>
`;
}

function navDocument(meta: EpubMetadata, toc: RenderedBody["toc"]): string {
	// A nav doc must contain at least one entry; fall back to the title.
	const entries =
		toc.length > 0
			? toc.map((e) => `<li><a href="content.xhtml#${e.id}">${escapeXml(e.text)}</a></li>`)
			: [`<li><a href="content.xhtml">${escapeXml(meta.title)}</a></li>`];
	return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(meta.language ?? "en")}">
<head><meta charset="utf-8"/><title>${escapeXml(meta.title)}</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${entries.join("\n")}
</ol></nav>
</body>
</html>
`;
}

function packageDocument(meta: EpubMetadata): string {
	const modified = meta.modified ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:${escapeXml(meta.docId)}</dc:identifier>
    <dc:title>${escapeXml(meta.title)}</dc:title>
    <dc:language>${escapeXml(meta.language ?? "en")}</dc:language>
    <meta property="dcterms:modified">${escapeXml(modified)}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="content"/>
  </spine>
</package>
`;
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${PACKAGE_PATH}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

/** Render blocks to EPUB 3 bytes. */
export async function renderEpub(blocks: Block[], meta: EpubMetadata): Promise<Uint8Array> {
	const { xhtml, toc } = renderBody(blocks);
	// `mimetype` must come first and be stored uncompressed; every entry here
	// is stored, so that requirement is met by ordering alone.
	return zipStore([
		{ name: "mimetype", data: "application/epub+zip" },
		{ name: CONTAINER_PATH, data: CONTAINER_XML },
		{ name: PACKAGE_PATH, data: packageDocument(meta) },
		{ name: NAV_PATH, data: navDocument(meta, toc) },
		{ name: CONTENT_PATH, data: contentDocument(meta, xhtml) },
	]);
}
