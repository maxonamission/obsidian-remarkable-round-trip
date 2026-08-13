/**
 * What the plugin stores (PRD F1, F7, F9-basis).
 *
 * Kept apart from the settings *tab*: that module reaches into the Obsidian
 * API, and both the mark projection and the settings schema need the shape of
 * the settings without dragging a UI dependency into them (GP_E4_S3).
 */

import type { MappingTable } from "./id/mapping";
import type { OutputFormat } from "./sync/send";
import {
	DEFAULT_MARK_STYLES,
	MARK_STYLE_LABELS,
	type MarkStyle,
	type MarkStyles,
} from "./incoming/markstyles";

export type { MarkStyle, MarkStyles };
export { DEFAULT_MARK_STYLES, MARK_STYLE_LABELS };

export interface RoundTripSettings {
	/** Long-lived device token (empty = not paired). */
	deviceToken: string;
	/** Use a self-hosted rmfakecloud endpoint instead of the official cloud. */
	useCustomEndpoint: boolean;
	customEndpointUrl: string;
	/** Delivered document format (F3); PDF anchors annotations, EPUB reflows. */
	outputFormat: OutputFormat;
	/** Render frontmatter as a small title block instead of dropping it. */
	frontmatterAsTitleBlock: boolean;
	fontSize: number;
	lineHeight: number;
	margin: number;
	/** Watch folder (F6): auto-send notes dropped into this vault folder. */
	watchFolderEnabled: boolean;
	watchFolderPath: string;
	/** Where imported annotations land (F11): companion note or in the source. */
	annotationTarget: "companion" | "source";
	/** Vault folder for companion notes; empty = vault root. */
	annotationFolder: string;
	/** Import handwritten annotations as PNG images (F12). */
	importHandwriting: boolean;
	/** Vault folder for the rendered handwriting images. */
	handwritingFolder: string;
	/** Mirror vault folders on the device (GP_E2_S7); off = flat root uploads. */
	mirrorFolders: boolean;
	/** Device folder under which the vault tree is mirrored ("" = root). */
	deviceBaseFolder: string;
	/** How each recognised pen mark is written into the copy (GP_E3_S19). */
	markStyles: MarkStyles;
	/** Which reMarkable's screen the PDF page is sized for (GP_E6_S2). */
	deviceModel: DeviceModel;
	/** Named typography bundle; "custom" uses the three sliders (GP_E6_S3). */
	layoutPreset: LayoutPreset;
	/** Automatic page breaks before headings (GP_E6_S4). */
	pageBreakAtHeading: HeadingBreak;
	/** Announce minor/major updates with a brief what's-new notice (GP_E5_S3). */
	showUpdateNotice: boolean;
	/** Last plugin version this install has run; "" = fresh install. */
	lastSeenVersion: string;
	/** docId ↔ device document mapping (round-trip foundation, F5). */
	mappings: MappingTable;
}

export const DEFAULT_SETTINGS: RoundTripSettings = {
	deviceToken: "",
	useCustomEndpoint: false,
	customEndpointUrl: "",
	outputFormat: "pdf",
	frontmatterAsTitleBlock: false,
	fontSize: 11,
	lineHeight: 1.5,
	margin: 40,
	watchFolderEnabled: false,
	watchFolderPath: "reMarkable-out",
	annotationTarget: "companion",
	annotationFolder: "reMarkable-in",
	importHandwriting: true,
	markStyles: { ...DEFAULT_MARK_STYLES },
	handwritingFolder: "reMarkable-in/handwriting",
	mirrorFolders: true,
	deviceBaseFolder: "Obsidian",
	deviceModel: "rm2",
	layoutPreset: "custom",
	pageBreakAtHeading: "smart",
	showUpdateNotice: true,
	lastSeenVersion: "",
	mappings: {},
};

/**
 * Merge stored settings over the defaults. The smart page-break default is
 * for fresh installs only (GP_E6_S9): stored data that predates the setting
 * (any keys, but not this one) keeps the old manual default, so an upgrade
 * never silently repaginates notes on re-send.
 */
export function settingsFrom(stored: Partial<RoundTripSettings>): RoundTripSettings {
	const settings = { ...DEFAULT_SETTINGS, ...stored };
	if (Object.keys(stored).length > 0 && stored.pageBreakAtHeading === undefined) {
		settings.pageBreakAtHeading = "off";
	}
	return settings;
}

/** reMarkable screens the typesetter can target (GP_E6_S2). */
export type DeviceModel = "rm2" | "paperpro";

/**
 * Screen sizes in PDF points (device pixels / DPI × 72). The reMarkable 1,
 * 2 and Paper Pure share a screen; the Paper Pro differs. Sizing the page to
 * the actual screen keeps the 1:1 page grid (K2) that anchoring relies on.
 * Both are 3:4 portrait — the shape the incoming ink transform assumes. The
 * Paper Pro Move (954×1696, 9:16) is deliberately NOT offered: its aspect
 * would make the device-to-page mapping anisotropic, and no Move is
 * available to validate against. Own story once one is.
 */
export const DEVICE_PAGE_SIZES: Record<DeviceModel, { pageWidth: number; pageHeight: number }> = {
	rm2: { pageWidth: 447, pageHeight: 596 }, // 1404×1872 @ 226 dpi (rM1/rM2/Paper Pure)
	paperpro: { pageWidth: 509, pageHeight: 679 }, // 1620×2160 @ 229 dpi
};

/** Named typography bundles (GP_E6_S3); "custom" falls back to the sliders. */
export type LayoutPreset = "readable" | "form" | "compact" | "custom";

export const LAYOUT_PRESETS: Record<
	Exclude<LayoutPreset, "custom">,
	{ fontSize: number; lineHeight: number; margin: number }
> = {
	readable: { fontSize: 13, lineHeight: 1.6, margin: 44 },
	form: { fontSize: 11, lineHeight: 1.5, margin: 40 },
	compact: { fontSize: 9, lineHeight: 1.3, margin: 30 },
};

/** The typography a send should actually use: preset bundle or the sliders. */
export function layoutFor(settings: RoundTripSettings): {
	fontSize: number;
	lineHeight: number;
	margin: number;
} {
	if (settings.layoutPreset !== "custom") return { ...LAYOUT_PRESETS[settings.layoutPreset] };
	return {
		fontSize: settings.fontSize,
		lineHeight: settings.lineHeight,
		margin: settings.margin,
	};
}

/**
 * Automatic page breaks before headings (GP_E6_S4); "smart" packs instead of
 * breaking unconditionally (GP_E6_S9): a #/## section starts on a fresh page
 * only when it does not fit whole in the space left on the current one.
 */
export type HeadingBreak = "off" | "h1" | "h2" | "smart";

/** The heading level up to which sends break the page; 0 = manual only. */
export function breakLevelFor(settings: RoundTripSettings): number {
	return { off: 0, h1: 1, h2: 2, smart: 0 }[settings.pageBreakAtHeading];
}

/** Whether sends should measure #/## sections and pack them (GP_E6_S9). */
export function packFor(settings: RoundTripSettings): boolean {
	return settings.pageBreakAtHeading === "smart";
}
