/**
 * Markdown ↔ device text paragraphs (PRD F17/F18, GP_E7_S2).
 *
 * The write-mode contract: the F18 style subset maps onto the device's own
 * paragraph styles, and *everything else travels literally* (F17) — a line
 * the device cannot style is carried as plain text with its markdown syntax
 * intact, so the round-trip never loses information. Completing the subset
 * (heading levels, italics, nested bullets) is GP_E7_S4.
 */

import { PARAGRAPH_STYLE, type TextParagraph } from "./rmtext";

/**
 * Markdown → device paragraphs, F18 subset: `#`/`##` → heading, whole-line
 * bold → bold, `- ` → bullet, `- [ ]`/`- [x]` → checkbox; everything else
 * plain, markers preserved as literal text so nothing is lost (F17).
 */
export function paragraphsFromMarkdown(markdown: string): TextParagraph[] {
	return markdown
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line): TextParagraph => {
			const heading = line.match(/^#{1,2}\s+(.*)$/);
			if (heading) return { text: heading[1], style: PARAGRAPH_STYLE.heading };
			const checked = line.match(/^- \[x\]\s+(.*)$/i);
			if (checked) return { text: checked[1], style: PARAGRAPH_STYLE.checkboxChecked };
			const open = line.match(/^- \[ \]\s+(.*)$/);
			if (open) return { text: open[1], style: PARAGRAPH_STYLE.checkbox };
			const bullet = line.match(/^[-*]\s+(.*)$/);
			if (bullet) return { text: bullet[1], style: PARAGRAPH_STYLE.bullet };
			const bold = line.match(/^\*\*([^*]+)\*\*$/);
			if (bold) return { text: bold[1], style: PARAGRAPH_STYLE.bold };
			return { text: line, style: PARAGRAPH_STYLE.plain };
		});
}

/** Device paragraphs → markdown, the reverse of `paragraphsFromMarkdown`. */
export function markdownFromParagraphs(paragraphs: TextParagraph[]): string {
	const line = (p: TextParagraph): string => {
		switch (p.style) {
			case PARAGRAPH_STYLE.heading:
				return `## ${p.text}`;
			case PARAGRAPH_STYLE.bold:
				return `**${p.text}**`;
			case PARAGRAPH_STYLE.bullet:
			case PARAGRAPH_STYLE.bullet2:
				return `- ${p.text}`;
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
