import { describe, expect, it } from "vitest";
import { preprocess, parseFrontmatter, EmbedContent } from "../preprocess/preprocess";

describe("parseFrontmatter", () => {
	it("splits frontmatter fields from the body", () => {
		const { fields, body } = parseFrontmatter("---\ntitle: Test\nstatus: doing\n---\nBody");
		expect(fields).toEqual({ title: "Test", status: "doing" });
		expect(body).toBe("Body");
	});

	it("joins a YAML list into one readable value", () => {
		const { fields } = parseFrontmatter(
			"---\ntags:\n  - frontmattertest\n  - tweede\nauthor: Max\n---\nBody",
		);
		expect(fields).toEqual({ tags: "frontmattertest, tweede", author: "Max" });
	});

	it("reads an inline flow sequence", () => {
		const { fields } = parseFrontmatter('---\ntags: [een, "twee"]\n---\nBody');
		expect(fields.tags).toBe("een, twee");
	});

	it("does not attach list items to an unrelated earlier key", () => {
		const { fields } = parseFrontmatter("---\nauthor: Max\ntags:\n  - een\n---\nBody");
		expect(fields.author).toBe("Max");
		expect(fields.tags).toBe("een");
	});

	it("leaves content without frontmatter untouched", () => {
		const { fields, body } = parseFrontmatter("Just text\n---\nnot frontmatter");
		expect(fields).toEqual({});
		expect(body).toContain("Just text");
	});
});

describe("preprocess", () => {
	it("strips frontmatter by default", () => {
		const result = preprocess("---\ntitle: X\n---\nHello");
		expect(result.markdown).toBe("Hello\n");
		expect(result.frontmatter).toEqual({ title: "X" });
	});

	it("renders frontmatter as title block when asked, hiding internal keys", () => {
		const result = preprocess(
			"---\nauthor: Max\nremarkable-id: abc\n---\nBody",
			{ frontmatterAsTitleBlock: true },
		);
		expect(result.markdown).toContain("- author: Max");
		expect(result.markdown).not.toContain("remarkable-id");
	});

	it("keeps user-authored tags in the title block (real beta note)", () => {
		const result = preprocess(
			"---\ntags:\n  - frontmattertest\nremarkable-id: 1d867b85-120e-4e4d-b144-412a56d97652\n---\nText",
			{ frontmatterAsTitleBlock: true },
		);
		expect(result.markdown).toContain("- tags: frontmattertest");
		expect(result.markdown).not.toContain("1d867b85");
		expect(result.markdown).toContain("Text");
	});

	it("flattens wikilinks to their display text", () => {
		const result = preprocess("Zie [[map/Nota#Sectie]] en [[Andere|de alias]].");
		expect(result.markdown).toBe("Zie Nota › Sectie en de alias.\n");
	});

	it("resolves markdown embeds inline", () => {
		const resolve = (linkpath: string): EmbedContent =>
			linkpath === "Deel"
				? { kind: "markdown", content: "---\nx: y\n---\nIngevoegde tekst" }
				: { kind: "missing" };
		const result = preprocess("Voor\n![[Deel]]\nNa", { resolveEmbed: resolve });
		expect(result.markdown).toContain("Ingevoegde tekst");
		expect(result.markdown).not.toContain("x: y");
	});

	it("guards against embed cycles", () => {
		const resolve = (): EmbedContent => ({ kind: "markdown", content: "loop ![[Zelf]]" });
		const result = preprocess("![[Zelf]]", { resolveEmbed: resolve });
		expect(result.markdown).toContain("*[embed: Zelf]*");
	});

	it("marks missing embeds and reports them", () => {
		const result = preprocess("![[Bestaat niet]]");
		expect(result.markdown).toContain("*[missing embed: Bestaat niet]*");
		expect(result.missingEmbeds).toEqual(["Bestaat niet"]);
	});

	it("replaces image embeds and markdown images with placeholders", () => {
		const result = preprocess("![[foto.png]]\n\n![alt](https://x/y.png)");
		expect(result.markdown).toContain("*[image: foto.png]*");
		expect(result.markdown).toContain("*[image: alt]*");
	});

	it("flattens callouts to titled blockquotes", () => {
		const result = preprocess("> [!warning] Pas op\n> Inhoud");
		expect(result.markdown).toContain("> **Pas op**");
		expect(result.markdown).toContain("> Inhoud");
	});

	it("removes Obsidian comments", () => {
		const result = preprocess("Zichtbaar %%verborgen%% blijft");
		expect(result.markdown).toBe("Zichtbaar  blijft\n");
	});
});
