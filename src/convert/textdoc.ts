/**
 * Markdown ↔ device text paragraphs (PRD F17/F18, GP_E7_S2/S4).
 *
 * The write-mode contract: the F18 style subset maps onto the device's own
 * paragraph styles, and *everything else travels literally* (F17) — a line
 * the device cannot style is carried as plain text with its markdown syntax
 * intact, so the round-trip never loses information.
 *
 * The rule that makes that watertight (GP_E7_S4): ONLY the exact canonical
 * spelling of each form maps to a style, and each style maps back to that
 * same spelling — so mapping is the identity for everything it touches and
 * canonicalText(x) === x for every input. Variants stay literal on purpose:
 * `# ` (the format has ONE heading level; mapping h1 would return as `##`),
 * `* `/`+ ` bullets, `[X]`/custom task markers, space-indented or deeper
 * nesting, and all inline styling. What the format itself does not offer —
 * more heading levels, an italic paragraph style, checkbox or third-level
 * bullet depth — is a documented boundary, not a silent degradation
 * (docs/ontwerp-schrijfmodus.md §7).
 */

import { PARAGRAPH_STYLE, type TextParagraph } from "./rmtext";

/**
 * Markdown → device paragraphs, F18 subset: `## ` → heading (the format's
 * only level), whole-line `**bold**` → bold, `- ` → bullet, one-tab `\t- `
 * → second-level bullet, `- [ ]`/`- [x]` → checkbox; everything else plain,
 * markers preserved as literal text so nothing is lost (F17).
 */
export function paragraphsFromMarkdown(markdown: string): TextParagraph[] {
	return markdown
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line): TextParagraph => {
			const heading = line.match(/^## (.*)$/);
			if (heading) return { text: heading[1], style: PARAGRAPH_STYLE.heading };
			const checked = line.match(/^- \[x\] (.*)$/);
			if (checked) return { text: checked[1], style: PARAGRAPH_STYLE.checkboxChecked };
			const open = line.match(/^- \[ \] (.*)$/);
			if (open) return { text: open[1], style: PARAGRAPH_STYLE.checkbox };
			const nested = line.match(/^\t- (.*)$/);
			if (nested) return { text: nested[1], style: PARAGRAPH_STYLE.bullet2 };
			const bullet = line.match(/^- (.*)$/);
			if (bullet) return { text: bullet[1], style: PARAGRAPH_STYLE.bullet };
			const bold = line.match(/^\*\*([^*]+)\*\*$/);
			if (bold) return { text: bold[1], style: PARAGRAPH_STYLE.bold };
			return { text: line, style: PARAGRAPH_STYLE.plain };
		});
}

/**
 * What markdown looks like after one trip through the style subset — the
 * text an UNEDITED device copy reads back as. `# ` normalises to `## `
 * (the device has one heading style); everything else survives verbatim.
 * Stable under repetition: canonicalText(canonicalText(x)) === canonicalText(x).
 */
export function canonicalText(markdown: string): string {
	return markdownFromParagraphs(paragraphsFromMarkdown(markdown));
}

/**
 * Device paragraphs → markdown, the exact reverse of
 * `paragraphsFromMarkdown`. A style the device added to a line whose text
 * still carries markdown syntax comes back as that style's spelling plus
 * the literal text — never merged, never dropped. Unknown future styles
 * degrade to the bare text: the words always survive.
 */
export function markdownFromParagraphs(paragraphs: TextParagraph[]): string {
	const line = (p: TextParagraph): string => {
		switch (p.style) {
			case PARAGRAPH_STYLE.heading:
				return `## ${p.text}`;
			case PARAGRAPH_STYLE.bold:
				return `**${p.text}**`;
			case PARAGRAPH_STYLE.bullet:
				return `- ${p.text}`;
			case PARAGRAPH_STYLE.bullet2:
				return `\t- ${p.text}`;
			case PARAGRAPH_STYLE.checkbox:
				return `- [ ] ${p.text}`;
			case PARAGRAPH_STYLE.checkboxChecked:
				return `- [x] ${p.text}`;
			default:
				return p.text;
		}
	};
	return paragraphs.map(line).join("\n");
}
