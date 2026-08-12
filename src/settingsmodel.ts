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
	showUpdateNotice: true,
	lastSeenVersion: "",
	mappings: {},
};
