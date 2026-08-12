import { describe, expect, it } from "vitest";
import { flattenSelection, relativeFolderPath, SelectionKind } from "../sync/selection";

/** Minimal stand-in for Obsidian's TFile/TFolder tree. */
interface Node {
	path: string;
	children?: Node[];
	ext?: string;
}

const note = (path: string): Node => ({ path, ext: "md" });
const folder = (path: string, children: Node[]): Node => ({ path, children });

function classify(item: Node): SelectionKind<Node> {
	if (item.children) return { kind: "folder", children: item.children };
	return item.ext === "md" ? { kind: "note" } : { kind: "other" };
}

const flatten = (selection: Node[]) => flattenSelection(selection, classify).map((n) => n.path);

describe("flattenSelection", () => {
	it("keeps a plain multi-selection of notes in order", () => {
		expect(flatten([note("a.md"), note("b.md")])).toEqual(["a.md", "b.md"]);
	});

	it("expands selected folders recursively", () => {
		const tree = folder("map", [
			note("map/een.md"),
			folder("map/sub", [note("map/sub/twee.md")]),
		]);
		expect(flatten([tree])).toEqual(["map/een.md", "map/sub/twee.md"]);
	});

	it("does not send a note twice when it and its folder are both selected", () => {
		const inner = note("map/een.md");
		const tree = folder("map", [inner]);
		expect(flatten([inner, tree])).toEqual(["map/een.md"]);
		expect(flatten([tree, inner])).toEqual(["map/een.md"]);
	});

	it("ignores non-markdown files (attachments in the selection)", () => {
		expect(flatten([note("a.md"), { path: "plaatje.png", ext: "png" }])).toEqual(["a.md"]);
	});

	it("returns nothing for a selection without notes", () => {
		expect(flatten([folder("leeg", []), { path: "x.pdf", ext: "pdf" }])).toEqual([]);
	});
});

describe("relativeFolderPath (GP_E5_S2)", () => {
	it("strips the sent folder's parent so the folder itself lands at the root", () => {
		expect(relativeFolderPath("Projecten/Training/Week 1", "Projecten")).toBe(
			"Training/Week 1",
		);
	});

	it("maps the root of the sent tree to the device root", () => {
		expect(relativeFolderPath("Projecten", "Projecten")).toBe("");
	});

	it("keeps paths as-is when the selection sits at the vault root", () => {
		expect(relativeFolderPath("Training/Week 1", "")).toBe("Training/Week 1");
		expect(relativeFolderPath("Training/Week 1", "/")).toBe("Training/Week 1");
	});

	it("does not treat a sibling prefix as a parent", () => {
		expect(relativeFolderPath("Projecten-archief/Oud", "Projecten")).toBe(
			"Projecten-archief/Oud",
		);
	});
});
