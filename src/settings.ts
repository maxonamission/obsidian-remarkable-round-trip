/**
 * Plugin settings + settings tab (PRD F1, F7, F9-basis).
 *
 * Three sections, so plain `setHeading` sections suffice (settings pattern:
 * accordion only from ~5 sections; documented in the story).
 */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type RoundTripPlugin from "./main";
import type { MappingTable } from "./id/mapping";
import { TransportError } from "./transport/http";

export interface RoundTripSettings {
	/** Long-lived device token (empty = not paired). */
	deviceToken: string;
	/** Use a self-hosted rmfakecloud endpoint instead of the official cloud. */
	useCustomEndpoint: boolean;
	customEndpointUrl: string;
	/** Render frontmatter as a small title block instead of dropping it. */
	frontmatterAsTitleBlock: boolean;
	fontSize: number;
	lineHeight: number;
	margin: number;
	/** Watch folder (F6): auto-send notes dropped into this vault folder. */
	watchFolderEnabled: boolean;
	watchFolderPath: string;
	/** Mirror vault folders on the device (GP_E2_S7); off = flat root uploads. */
	mirrorFolders: boolean;
	/** Device folder under which the vault tree is mirrored ("" = root). */
	deviceBaseFolder: string;
	/** docId ↔ device document mapping (round-trip foundation, F5). */
	mappings: MappingTable;
}

export const DEFAULT_SETTINGS: RoundTripSettings = {
	deviceToken: "",
	useCustomEndpoint: false,
	customEndpointUrl: "",
	frontmatterAsTitleBlock: false,
	fontSize: 11,
	lineHeight: 1.5,
	margin: 40,
	watchFolderEnabled: false,
	watchFolderPath: "reMarkable-out",
	mirrorFolders: true,
	deviceBaseFolder: "Obsidian",
	mappings: {},
};

export class RoundTripSettingTab extends PluginSettingTab {
	private pairingCode = "";

	constructor(
		app: App,
		private readonly plugin: RoundTripPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Connection").setHeading();

		const paired = this.plugin.settings.deviceToken !== "";
		new Setting(containerEl)
			.setName("Status")
			.setDesc(
				paired
					? "Paired with a reMarkable account."
					: "Not paired. Get a one-time code at my.remarkable.com/device/browser/connect.",
			);

		if (!paired) {
			new Setting(containerEl)
				.setName("Pair with one-time code")
				.setDesc("Enter the 8-letter code, then select Pair.")
				.addText((text) =>
					text
						.setPlaceholder("abcdefgh")
						.onChange((value) => {
							this.pairingCode = value;
						}),
				)
				.addButton((button) =>
					button
						.setButtonText("Pair")
						.setCta()
						.onClick(() => void this.pair()),
				);
		} else {
			new Setting(containerEl)
				.setName("Unpair")
				.setDesc("Forget the stored device token.")
				.addButton((button) =>
					// setWarning is deprecated in favor of setDestructive (1.13+),
					// but minAppVersion is 1.7.2 — keep the compatible API.
					button.setButtonText("Unpair").setWarning().onClick(() => void this.unpair()),
				);
		}

		new Setting(containerEl)
			.setName("Self-hosted endpoint (rmfakecloud)")
			.setDesc("Send documents to a self-hosted rmfakecloud server instead of the official reMarkable cloud.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useCustomEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.useCustomEndpoint = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.useCustomEndpoint) {
			new Setting(containerEl)
				.setName("rmfakecloud URL")
				.setDesc("Base URL of the self-hosted server, e.g. https://rm.example.org")
				.addText((text) =>
					text
						.setPlaceholder("https://rm.example.org")
						.setValue(this.plugin.settings.customEndpointUrl)
						.onChange(async (value) => {
							const url = value.trim();
							// Scheme guard: a typo here would only surface as a vague
							// network error at send time. http is allowed (LAN
							// rmfakecloud) but https is the sane default.
							if (url !== "" && !/^https?:\/\//i.test(url)) {
								new Notice("Endpoint URL must start with https:// (or http:// for LAN).");
								return;
							}
							this.plugin.settings.customEndpointUrl = url;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl).setName("Page layout").setHeading();

		new Setting(containerEl)
			.setName("Font size")
			.setDesc("Body text size in points (headings scale along).")
			.addSlider((slider) =>
				slider
					.setLimits(9, 14, 0.5)
					.setValue(this.plugin.settings.fontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.fontSize = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Line spacing")
			.setDesc("Line height as a multiple of the font size; roomier reads better on e-ink.")
			.addSlider((slider) =>
				slider
					.setLimits(1.2, 1.9, 0.1)
					.setValue(this.plugin.settings.lineHeight)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.lineHeight = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Page margin")
			.setDesc("Margin in points around the text — also your annotation space.")
			.addSlider((slider) =>
				slider
					.setLimits(24, 64, 4)
					.setValue(this.plugin.settings.margin)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.margin = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Device organization").setHeading();

		new Setting(containerEl)
			.setName("Mirror vault folders")
			.setDesc(
				"Recreate the vault folder structure on the device and replace the " +
					"previous copy when re-sending. Off: everything lands flat in the root.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.mirrorFolders)
					.onChange(async (value) => {
						this.plugin.settings.mirrorFolders = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.mirrorFolders) {
			new Setting(containerEl)
				.setName("Device base folder")
				.setDesc("Folder on the reMarkable that holds the mirrored vault tree; empty for the root.")
				.addText((text) =>
					text
						.setPlaceholder("Obsidian")
						.setValue(this.plugin.settings.deviceBaseFolder)
						.onChange(async (value) => {
							this.plugin.settings.deviceBaseFolder = value
								.trim()
								.replace(/^\/+|\/+$/g, "");
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl).setName("Watch folder").setHeading();

		new Setting(containerEl)
			.setName("Auto-send from a vault folder")
			.setDesc(
				"Notes created or changed in the folder below are converted and " +
					"uploaded automatically (after a short quiet period). Unchanged " +
					"notes are skipped.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.watchFolderEnabled)
					.onChange(async (value) => {
						this.plugin.settings.watchFolderEnabled = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Folder to watch")
			.setDesc("Vault path, e.g. reMarkable-out")
			.addText((text) =>
				text
					.setPlaceholder("reMarkable-out")
					.setValue(this.plugin.settings.watchFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.watchFolderPath = value.trim().replace(/^\/+|\/+$/g, "");
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Content").setHeading();

		new Setting(containerEl)
			.setName("Frontmatter as title block")
			.setDesc("Show frontmatter fields at the top of the document instead of dropping them.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.frontmatterAsTitleBlock)
					.onChange(async (value) => {
						this.plugin.settings.frontmatterAsTitleBlock = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private async pair(): Promise<void> {
		try {
			const client = this.plugin.createClient();
			const registration = await client.register(this.pairingCode);
			this.plugin.settings.deviceToken = registration.deviceToken;
			await this.plugin.saveSettings();
			new Notice("Paired with your reMarkable account.");
			this.display();
		} catch (error) {
			new Notice(
				error instanceof TransportError
					? error.message
					: "Pairing failed — check your connection and try again.",
			);
		}
	}

	private async unpair(): Promise<void> {
		this.plugin.settings.deviceToken = "";
		await this.plugin.saveSettings();
		new Notice("Device token removed.");
		this.display();
	}
}
