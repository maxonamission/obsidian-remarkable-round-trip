/**
 * Flattening a file-explorer multi-selection into the notes to send
 * (GP_E2_S14). Pure: the plugin edge injects how to classify an item, so
 * this runs in tests without Obsidian — same seam as the rest of the core.
 */

export type SelectionKind<T> =
	| { kind: "note" }
	| { kind: "folder"; children: T[] }
	| { kind: "other" };

/**
 * Depth-first collection of notes from a mixed selection of notes and
 * folders, de-duplicated by path: selecting a note *and* the folder holding
 * it must not send that note twice. Selection order is preserved.
 */
export function flattenSelection<T extends { path: string }>(
	selection: T[],
	classify: (item: T) => SelectionKind<T>,
): T[] {
	const out: T[] = [];
	const seen = new Set<string>();

	const walk = (items: T[]): void => {
		for (const item of items) {
			const classified = classify(item);
			if (classified.kind === "note") {
				if (!seen.has(item.path)) {
					seen.add(item.path);
					out.push(item);
				}
			} else if (classified.kind === "folder") {
				walk(classified.children);
			}
		}
	};

	walk(selection);
	return out;
}
