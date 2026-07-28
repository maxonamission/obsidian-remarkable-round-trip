/**
 * Page numbers for imported annotations (GP_E3_S8).
 *
 * A document's files are named after page *ids*, not page numbers:
 * `<doc>/<pageId>.rm` for strokes, `<doc>.highlights/<pageId>.json` for text
 * highlights. Only annotated pages get a file, so counting files gives the
 * wrong answer — write on page 7 alone and it looks like page 1. The order
 * lives in `.content`, which is what this module reads.
 *
 * The format has changed across firmware generations, so parsing stays
 * deliberately tolerant: an unreadable `.content` costs the page numbers, not
 * the import (N3).
 */

/**
 * One page of a document as the device sees it (GP_E3_S20).
 *
 * On a PDF, a page normally *shows* a page of that PDF — `redir.value` says
 * which one, zero-based. A page the reader added on the tablet to write on
 * has no PDF behind it, and carries no redirect. Both matter: an added page
 * has no text to anchor against, and it shifts every page after it, so
 * without this the annotations on later pages would be quoted against the
 * wrong page of the source.
 */
export interface PageEntry {
	id: string;
	/** 1-based page of the source PDF, or null for a page added on the device. */
	pdfPage: number | null;
}

/** Pages in document order, with what each one shows. */
export function parsePageEntries(contentJson: string): PageEntry[] {
	const ids = parsePageOrder(contentJson);
	const redirects = parseRedirects(contentJson);
	// A firmware that records no redirects at all tells us nothing about
	// added pages; then the old assumption — page N shows PDF page N — is
	// still the best available (N3).
	if (redirects.size === 0) {
		return ids.map((id, index) => ({ id, pdfPage: index + 1 }));
	}
	return ids.map((id) => {
		const redirect = redirects.get(id);
		return {
			id,
			pdfPage: redirect === undefined || redirect < 0 ? null : redirect + 1,
		};
	});
}

/** Page id → zero-based PDF page index, for the pages that carry one. */
function parseRedirects(contentJson: string): Map<string, number> {
	const out = new Map<string, number>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(contentJson);
	} catch {
		return out;
	}
	if (typeof parsed !== "object" || parsed === null) return out;
	const cPages = (parsed as Record<string, unknown>).cPages;
	if (typeof cPages !== "object" || cPages === null) return out;
	const pages = (cPages as Record<string, unknown>).pages;
	if (!Array.isArray(pages)) return out;
	for (const page of pages) {
		if (typeof page !== "object" || page === null) continue;
		const record = page as Record<string, unknown>;
		if (typeof record.id !== "string" || record.deleted !== undefined) continue;
		const redir = record.redir;
		if (typeof redir !== "object" || redir === null) continue;
		const value = (redir as Record<string, unknown>).value;
		if (typeof value === "number") out.set(record.id, value);
	}
	return out;
}

/** Page ids in document order; empty when the order cannot be determined. */
export function parsePageOrder(contentJson: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(contentJson);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null) return [];
	const root = parsed as Record<string, unknown>;

	// Current format (v6 sync): { cPages: { pages: [{ id, deleted?, … }] } }
	const cPages = root.cPages;
	if (typeof cPages === "object" && cPages !== null) {
		const pages = (cPages as Record<string, unknown>).pages;
		if (Array.isArray(pages)) {
			return (
				pages
					.filter(
						(page): page is Record<string, unknown> =>
							typeof page === "object" && page !== null,
					)
					// A deleted page keeps its slot in the array but is not shown on
					// the device, so counting it would shift every later page.
					.filter((page) => page.deleted === undefined)
					.map((page) => page.id)
					.filter((id): id is string => typeof id === "string")
			);
		}
	}

	// Older format: { pages: ["uuid", …] }
	if (Array.isArray(root.pages)) {
		return root.pages.filter((id): id is string => typeof id === "string");
	}
	return [];
}

/** The page id a document file belongs to, or null for files without one. */
export function pageIdOfFile(fileId: string): string | null {
	const name = fileId.split("/").pop() ?? fileId;
	const match = /^(.+)\.(rm|json)$/.exec(name);
	return match === null ? null : match[1];
}

/**
 * Look up 1-based page numbers by page id. Unknown ids stay undefined rather
 * than guessing: a wrong page number is worse than none.
 */
export class PageMap {
	private readonly entries: PageEntry[];
	private readonly byId: Map<string, number>;

	constructor(order: string[] | PageEntry[]) {
		this.entries = order.map((entry, index) =>
			typeof entry === "string" ? { id: entry, pdfPage: index + 1 } : entry,
		);
		this.byId = new Map(this.entries.map((entry, index) => [entry.id, index]));
	}

	get size(): number {
		return this.entries.length;
	}

	/** Pages the reader added on the device, in document order. */
	get addedPages(): PageEntry[] {
		return this.entries.filter((entry) => entry.pdfPage === null);
	}

	/** Page of the source PDF a page id shows; undefined when it shows none. */
	forPageId(pageId: string | null): number | undefined {
		if (pageId === null) return undefined;
		const index = this.byId.get(pageId);
		return index === undefined ? undefined : (this.entries[index].pdfPage ?? undefined);
	}

	/** Page of the source PDF a document file belongs to. */
	forFile(fileId: string): number | undefined {
		return this.forPageId(pageIdOfFile(fileId));
	}

	/** Was this page added on the device rather than shown from the PDF? */
	isAdded(fileId: string): boolean {
		const index = this.byId.get(pageIdOfFile(fileId) ?? "");
		return index !== undefined && this.entries[index].pdfPage === null;
	}

	/** Its position in the document as the reader sees it, 1-based. */
	positionOf(fileId: string): number | undefined {
		const index = this.byId.get(pageIdOfFile(fileId) ?? "");
		return index === undefined ? undefined : index + 1;
	}

	/**
	 * The source page an added page follows — where its notes belong in the
	 * text. Undefined when it was added before anything else.
	 */
	precedingPdfPage(fileId: string): number | undefined {
		const index = this.byId.get(pageIdOfFile(fileId) ?? "");
		if (index === undefined) return undefined;
		for (let at = index - 1; at >= 0; at--) {
			const page = this.entries[at].pdfPage;
			if (page !== null) return page;
		}
		return undefined;
	}
}
