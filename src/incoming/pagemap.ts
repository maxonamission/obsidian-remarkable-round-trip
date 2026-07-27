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
	private readonly numbers: Map<string, number>;

	constructor(order: string[]) {
		this.numbers = new Map(order.map((id, index) => [id, index + 1]));
	}

	get size(): number {
		return this.numbers.size;
	}

	/** Page number for a page id. */
	forPageId(pageId: string | null): number | undefined {
		return pageId === null ? undefined : this.numbers.get(pageId);
	}

	/** Page number for a document file path. */
	forFile(fileId: string): number | undefined {
		return this.forPageId(pageIdOfFile(fileId));
	}
}
