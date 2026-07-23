/**
 * Preprocessing of Obsidian-flavored markdown (PRD F2).
 *
 * Turns vault markdown into plain, converter-friendly markdown:
 * - frontmatter stripped (optionally rendered as a small title block),
 * - `![[embeds]]` resolved inline (with recursion/cycle guards),
 * - `[[wikilinks]]` flattened to their display text,
 * - callouts flattened to titled blockquotes,
 * - `%%comments%%` removed.
 *
 * Vault access stays outside: callers inject an EmbedResolver, so this module
 * is pure and unit-testable (and mobile-safe per N7 — no Node APIs).
 */

export type EmbedContent =
	| { kind: "markdown"; content: string }
	| { kind: "image"; name: string }
	| { kind: "missing" };

export type EmbedResolver = (linkpath: string) => EmbedContent;

export interface PreprocessOptions {
	/** Resolve an embed target to its content. Default: treat as missing. */
	resolveEmbed?: EmbedResolver;
	/** Render frontmatter fields as a title block instead of dropping them. */
	frontmatterAsTitleBlock?: boolean;
	/** Frontmatter keys never shown in the title block. */
	hiddenFrontmatterKeys?: string[];
	/** Maximum embed nesting depth (cycle safety net). */
	maxEmbedDepth?: number;
}

export interface PreprocessResult {
	markdown: string;
	/** Frontmatter of the root note, as raw key → value strings. */
	frontmatter: Record<string, string>;
	/** Embed targets that could not be resolved. */
	missingEmbeds: string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const COMMENT_RE = /%%[\s\S]*?%%/g;
const EMBED_RE = /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const CALLOUT_HEAD_RE = /^>\s*\[!([a-zA-Z-]+)\][+-]?\s*(.*)$/;

const IMAGE_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif",
]);

/** Parse a frontmatter block into flat key → raw string value pairs. */
export function parseFrontmatter(source: string): {
	fields: Record<string, string>;
	body: string;
} {
	const match = source.match(FRONTMATTER_RE);
	if (!match) return { fields: {}, body: source };
	const fields: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!kv) continue; // nested/list values: skip, we only surface scalars
		const value = kv[2].trim().replace(/^["']|["']$/g, "");
		fields[kv[1]] = value;
	}
	return { fields, body: source.slice(match[0].length) };
}

function displayTextForLink(target: string, alias: string | undefined): string {
	if (alias !== undefined && alias.trim() !== "") return alias.trim();
	// Drop path and heading/block suffixes: "dir/Note#Section" → "Note › Section".
	const [path, ...anchors] = target.split("#");
	const base = (path.split("/").pop() ?? path).trim();
	const anchor = anchors.filter((a) => !a.startsWith("^")).join(" › ").trim();
	if (base === "" && anchor !== "") return anchor;
	return anchor !== "" ? `${base} › ${anchor}` : base;
}

function isImageTarget(target: string): boolean {
	const ext = target.split("#")[0].split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_EXTENSIONS.has(ext);
}

/** Flatten a callout block to a blockquote with a bold title line. */
function flattenCallouts(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const head = line.match(CALLOUT_HEAD_RE);
		if (head) {
			const type = head[1].toLowerCase();
			const title = head[2].trim();
			const label = title !== "" ? title : type.charAt(0).toUpperCase() + type.slice(1);
			out.push(`> **${label}**`);
		} else {
			out.push(line);
		}
	}
	return out.join("\n");
}

function resolveEmbeds(
	markdown: string,
	options: Required<Pick<PreprocessOptions, "resolveEmbed" | "maxEmbedDepth">>,
	depth: number,
	seen: Set<string>,
	missing: string[],
): string {
	return markdown.replace(EMBED_RE, (_all, rawTarget: string, alias?: string) => {
		const target = rawTarget.trim();
		if (isImageTarget(target)) {
			const name = displayTextForLink(target, alias);
			return `*[image: ${name}]*`;
		}
		if (depth >= options.maxEmbedDepth || seen.has(target)) {
			return `*[embed: ${displayTextForLink(target, alias)}]*`;
		}
		const resolved = options.resolveEmbed(target);
		if (resolved.kind === "missing") {
			missing.push(target);
			return `*[missing embed: ${displayTextForLink(target, alias)}]*`;
		}
		if (resolved.kind === "image") {
			return `*[image: ${resolved.name}]*`;
		}
		const nested = new Set(seen);
		nested.add(target);
		const { body } = parseFrontmatter(resolved.content);
		const inner = resolveEmbeds(
			body.replace(COMMENT_RE, ""),
			options,
			depth + 1,
			nested,
			missing,
		);
		return `\n${inner.trim()}\n`;
	});
}

function renderTitleBlock(
	fields: Record<string, string>,
	hidden: Set<string>,
): string {
	const shown = Object.entries(fields).filter(
		([key, value]) => !hidden.has(key) && value !== "",
	);
	if (shown.length === 0) return "";
	const lines = shown.map(([key, value]) => `- ${key}: ${value}`);
	return `${lines.join("\n")}\n\n---\n\n`;
}

/** Default frontmatter keys that never belong in a rendered title block. */
export const DEFAULT_HIDDEN_FRONTMATTER_KEYS = [
	"remarkable-id",
	"position",
	"cssclass",
	"cssclasses",
	"aliases",
	"tags",
];

export function preprocess(
	source: string,
	options: PreprocessOptions = {},
): PreprocessResult {
	const resolveEmbed = options.resolveEmbed ?? (() => ({ kind: "missing" }) as const);
	const maxEmbedDepth = options.maxEmbedDepth ?? 3;
	const hidden = new Set(
		options.hiddenFrontmatterKeys ?? DEFAULT_HIDDEN_FRONTMATTER_KEYS,
	);

	const { fields, body } = parseFrontmatter(source);
	const missingEmbeds: string[] = [];

	let text = body.replace(COMMENT_RE, "");
	text = resolveEmbeds(text, { resolveEmbed, maxEmbedDepth }, 0, new Set(), missingEmbeds);
	// Markdown images (external or resolved paths) → placeholder, keep alt text.
	text = text.replace(MD_IMAGE_RE, (_all, alt: string) => {
		return `*[image${alt ? `: ${alt}` : ""}]*`;
	});
	text = text.replace(WIKILINK_RE, (_all, target: string, alias?: string) =>
		displayTextForLink(target.trim(), alias),
	);
	text = flattenCallouts(text);

	const titleBlock = options.frontmatterAsTitleBlock
		? renderTitleBlock(fields, hidden)
		: "";

	return {
		markdown: `${titleBlock}${text.trim()}\n`,
		frontmatter: fields,
		missingEmbeds,
	};
}
