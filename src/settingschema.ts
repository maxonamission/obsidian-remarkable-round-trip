/**
 * What the settings screen contains, as data (GP_E4_S3).
 *
 * Obsidian 1.13's declarative settings API renders this and indexes it for
 * the settings search. The screen-as-data survived the deletion of the
 * pre-1.13 imperative renderer (GP_E5_S8, minAppVersion 1.13.0): one
 * description remains the single source for rendering, search and the
 * schema tests.
 *
 * Deliberately free of any Obsidian import, so the description stays testable
 * and cannot pick up a dependency on the renderer it feeds.
 */

import { MARK_STYLE_LABELS } from "./incoming/markstyles";
import type { DeviceModel, HeadingBreak, LayoutPreset } from "./settingsmodel";

/** GP_E6_S2: which screen the PDF page is sized for. Typed against the
 * model union so a new DeviceModel without a label is a compile error. */
export const DEVICE_MODEL_LABELS: Record<DeviceModel, string> = {
	rm2: "reMarkable 1 / 2 / Paper Pure",
	paperpro: "reMarkable Paper Pro",
};

/** GP_E6_S4: automatic page breaks before headings; GP_E6_S9 adds smart. */
export const HEADING_BREAK_LABELS: Record<HeadingBreak, string> = {
	smart: "Smart — new page only when a section won't fit (recommended)",
	off: "Off — only at \\pagebreak markers",
	h1: "Before # headings",
	h2: "Before # and ## headings",
};

/** GP_E6_S3: named typography bundles; custom exposes the sliders. */
export const LAYOUT_PRESET_LABELS: Record<LayoutPreset, string> = {
	readable: "Easy reading — larger type, roomy lines",
	form: "Fill-in form — balanced, with writing space",
	compact: "Compact — as much on a page as fits",
	custom: "Custom — use the sliders below",
};

export type ControlSpec =
	| { type: "toggle" }
	| { type: "dropdown"; options: Record<string, string> }
	| { type: "text"; placeholder?: string; sanitise?: "path" | "url" }
	| { type: "slider"; min: number; max: number; step: number };

/** Show this setting only when another one has a given value. */
export interface VisibleWhen {
	key: string;
	equals: unknown;
}

export interface SettingSpec {
	/** Dotted path into the settings object, e.g. `markStyles.circle`. */
	key: string;
	name: string;
	desc: string;
	control: ControlSpec;
	/** One condition, or several that must ALL hold (GP_E6_S3). */
	visibleWhen?: VisibleWhen | VisibleWhen[];
	/**
	 * Changing this reveals or hides other settings, so the tab has to be
	 * drawn again.
	 */
	refresh?: boolean;
}

export interface SectionSpec {
	heading: string;
	/** A line under the heading, before the first setting. */
	note?: string;
	items: SettingSpec[];
}

/** Read a dotted key out of a settings object. */
export function readSetting(settings: unknown, key: string): unknown {
	return key.split(".").reduce<unknown>((value, part) => {
		if (typeof value !== "object" || value === null) return undefined;
		return (value as Record<string, unknown>)[part];
	}, settings);
}

/** Write a dotted key, copying the objects along the path rather than mutating. */
export function writeSetting<T>(settings: T, key: string, value: unknown): T {
	const [head, ...rest] = key.split(".");
	if (rest.length === 0) return { ...settings, [head]: value };
	const nested = (settings as Record<string, unknown>)[head];
	return {
		...settings,
		[head]: writeSetting(nested as Record<string, unknown>, rest.join("."), value),
	};
}

/** The visibility conditions of a setting, normalised to a list. */
export function conditionsOf(spec: SettingSpec): VisibleWhen[] {
	if (spec.visibleWhen === undefined) return [];
	return Array.isArray(spec.visibleWhen) ? spec.visibleWhen : [spec.visibleWhen];
}

/**
 * The slider bounds of a schema entry; the layout modal (GP_E6_S10) reuses
 * them so bounds are never redeclared. Throws on a non-slider key — covered
 * by a test so a schema rename cannot silently strand the modal.
 */
export function sliderSpec(key: string): { min: number; max: number; step: number } {
	for (const section of SETTING_SECTIONS) {
		for (const item of section.items) {
			if (item.key === key && item.control.type === "slider") return item.control;
		}
	}
	throw new Error(`No slider spec for "${key}" in the settings schema.`);
}

/** Is this setting shown, given the current values? */
export function isVisible(spec: SettingSpec, settings: unknown): boolean {
	return conditionsOf(spec).every((c) => readSetting(settings, c.key) === c.equals);
}

/** Trim a vault or device folder path to the form the plugin stores. */
export function cleanPath(value: string): string {
	return value.trim().replace(/^\/+|\/+$/g, "");
}

/**
 * A typo in the endpoint would otherwise surface as a vague network error at
 * send time. http is allowed (a LAN rmfakecloud) but https is the default.
 */
export function checkEndpoint(value: string): string | undefined {
	const url = value.trim();
	if (url !== "" && !/^https?:\/\//i.test(url)) {
		return "Endpoint URL must start with https:// (or http:// for LAN).";
	}
	return undefined;
}

export const SETTING_SECTIONS: SectionSpec[] = [
	{
		heading: "Connection",
		items: [
			{
				key: "useCustomEndpoint",
				name: "Self-hosted endpoint (rmfakecloud)",
				desc:
					"Send documents to a self-hosted rmfakecloud server instead of the " +
					"official reMarkable cloud.",
				control: { type: "toggle" },
				refresh: true,
			},
			{
				key: "customEndpointUrl",
				name: "rmfakecloud URL",
				desc: "Base URL of the self-hosted server, e.g. https://rm.example.org",
				control: { type: "text", placeholder: "https://rm.example.org", sanitise: "url" },
				visibleWhen: { key: "useCustomEndpoint", equals: true },
			},
		],
	},
	{
		heading: "Document format",
		items: [
			{
				key: "outputFormat",
				name: "Send notes as",
				desc:
					"PDF keeps a fixed page layout, which is what annotations anchor to — " +
					"the right choice if you plan to write on the document. EPUB reflows, " +
					"so the device picks the font size and it handles non-Latin scripts " +
					"better; best for reading only.",
				control: {
					type: "dropdown",
					options: {
						pdf: "PDF — fixed layout, best for annotating",
						epub: "EPUB — reflowable, best for reading",
					},
				},
				refresh: true,
			},
		],
	},
	{
		// Typography only shapes the PDF; an EPUB is laid out by the reader, so
		// showing these there would promise control the plugin does not have.
		heading: "Page layout",
		items: [
			{
				key: "deviceModel",
				name: "reMarkable model",
				desc:
					"Pages are sized to this screen, so what you send fills the " +
					"device exactly. The reMarkable 1, 2 and Paper Pure share a screen.",
				control: { type: "dropdown", options: DEVICE_MODEL_LABELS },
				visibleWhen: { key: "outputFormat", equals: "pdf" },
			},
			{
				key: "pageBreakAtHeading",
				name: "Start a new page at headings",
				desc:
					"Smart measures each # or ## section and turns the page only " +
					"when it would be split; the level options always break " +
					"there — a weekly log with a heading per day gets each day " +
					"on its own page. A \\pagebreak line works everywhere, " +
					"whatever this says.",
				control: { type: "dropdown", options: HEADING_BREAK_LABELS },
				visibleWhen: { key: "outputFormat", equals: "pdf" },
			},
			{
				key: "layoutPreset",
				name: "Layout",
				desc:
					"What the page is for. Each choice sets type size, line spacing " +
					"and margins; pick Custom to use the sliders yourself.",
				control: { type: "dropdown", options: LAYOUT_PRESET_LABELS },
				visibleWhen: { key: "outputFormat", equals: "pdf" },
				refresh: true,
			},
			{
				key: "fontSize",
				name: "Font size",
				desc: "Body text size in points (headings scale along).",
				control: { type: "slider", min: 9, max: 14, step: 0.5 },
				visibleWhen: [
					{ key: "outputFormat", equals: "pdf" },
					{ key: "layoutPreset", equals: "custom" },
				],
			},
			{
				key: "lineHeight",
				name: "Line spacing",
				desc: "Line height as a multiple of the font size; roomier reads better on e-ink.",
				control: { type: "slider", min: 1.2, max: 1.9, step: 0.1 },
				visibleWhen: [
					{ key: "outputFormat", equals: "pdf" },
					{ key: "layoutPreset", equals: "custom" },
				],
			},
			{
				key: "margin",
				name: "Page margin",
				desc: "Margin in points around the text — also your annotation space.",
				control: { type: "slider", min: 24, max: 64, step: 4 },
				visibleWhen: [
					{ key: "outputFormat", equals: "pdf" },
					{ key: "layoutPreset", equals: "custom" },
				],
			},
		],
	},
	{
		heading: "Device organization",
		items: [
			{
				key: "mirrorFolders",
				name: "Mirror vault folders",
				desc:
					"Recreate the vault folder structure on the device and replace the " +
					"previous copy when re-sending. Off: everything lands flat in the root.",
				control: { type: "toggle" },
				refresh: true,
			},
			{
				key: "deviceBaseFolder",
				name: "Device base folder",
				desc: "Folder on the reMarkable that holds the mirrored vault tree; empty for the root.",
				control: { type: "text", placeholder: "Obsidian", sanitise: "path" },
				visibleWhen: { key: "mirrorFolders", equals: true },
			},
		],
	},
	{
		heading: "Annotations back into the vault",
		items: [
			{
				key: "annotationTarget",
				name: "Where imported annotations land",
				desc:
					"A companion note keeps your source note untouched and links back to it. " +
					"Writing into the source note itself is possible, but the plugin then " +
					"edits a note you wrote — it only ever replaces its own marked block.",
				control: {
					type: "dropdown",
					options: {
						companion: "Companion note (recommended)",
						source: "Section inside the source note",
					},
				},
				refresh: true,
			},
			{
				key: "annotationFolder",
				name: "Folder for companion notes",
				desc: "Vault path, e.g. reMarkable-in; empty puts them in the vault root.",
				control: { type: "text", placeholder: "reMarkable-in", sanitise: "path" },
				visibleWhen: { key: "annotationTarget", equals: "companion" },
			},
			{
				key: "linkSourceToAnnotations",
				name: "Link the source note to its annotations",
				desc:
					"After an import, the source note gets an “annotations” property " +
					"linking to its companion note, so the two are one click apart. " +
					"The companion note always links back to the source. This is the " +
					"only thing the plugin ever writes into your note besides its id.",
				control: { type: "toggle" },
				visibleWhen: { key: "annotationTarget", equals: "companion" },
			},
			{
				key: "importHandwriting",
				name: "Import handwriting as images",
				desc:
					"Handwritten notes and freehand marks are pen strokes, not text. " +
					"With this on, each written page is rendered to a PNG and embedded " +
					"with the annotations so you can read it back.",
				control: { type: "toggle" },
				refresh: true,
			},
			{
				key: "handwritingFolder",
				name: "Folder for handwriting images",
				desc: "Vault path where the rendered pages are stored.",
				control: { type: "text", placeholder: "reMarkable-in/handwriting", sanitise: "path" },
				visibleWhen: { key: "importHandwriting", equals: true },
			},
		],
	},
	{
		heading: "What a pen mark becomes",
		note:
			"The shapes are fixed — they are what a pen can draw — but what they mean " +
			"is your own convention. A bar in the margin always quotes the lines it " +
			"ran alongside, and handwriting always comes back as an image.",
		items: [
			{
				key: "markStyles.strikethrough",
				name: "Line through words",
				desc: "A flat stroke crossing the letters, in one pass or several.",
				control: { type: "dropdown", options: MARK_STYLE_LABELS },
			},
			{
				key: "markStyles.circle",
				name: "Loop around words",
				desc: "A closed shape drawn around a word or phrase.",
				control: { type: "dropdown", options: MARK_STYLE_LABELS },
			},
			{
				key: "markStyles.underline",
				name: "Line under words",
				desc: "A flat stroke below the letters, clear of the baseline.",
				control: { type: "dropdown", options: MARK_STYLE_LABELS },
			},
		],
	},
	{
		heading: "Watch folder",
		items: [
			{
				key: "watchFolderEnabled",
				name: "Auto-send from a vault folder",
				desc:
					"Notes created or changed in the folder below are converted and " +
					"uploaded automatically (after a short quiet period). Unchanged " +
					"notes are skipped.",
				control: { type: "toggle" },
			},
			{
				key: "watchFolderPath",
				name: "Folder to watch",
				desc: "Vault path, e.g. reMarkable-out",
				control: { type: "text", placeholder: "reMarkable-out", sanitise: "path" },
			},
		],
	},
	{
		heading: "Content",
		items: [
			{
				key: "frontmatterAsTitleBlock",
				name: "Frontmatter as title block",
				desc:
					"Off (default): frontmatter is left out of the PDF. On: your fields " +
					"(tags, author, dates…) are listed under the title; the plugin's own " +
					"remarkable-id stays hidden.",
				control: { type: "toggle" },
			},
		],
	},
	{
		heading: "Updates",
		items: [
			{
				key: "showUpdateNotice",
				name: "Notify about new versions",
				desc:
					"After an update to a new major or minor version, show a brief " +
					"notice linking to what changed. Patch releases stay silent.",
				control: { type: "toggle" },
			},
		],
	},
];
