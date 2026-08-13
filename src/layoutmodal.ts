/**
 * Per-send layout choice (GP_E6_S10).
 *
 * One extra context-menu entry — not an entry per preset — opens this modal:
 * the user picks a layout and page-break mode for THIS send only, prefilled
 * from the stored settings, which stay untouched. Anchors are safe by
 * construction: every upload records its resolved layout in the mapping, so
 * an override simply rides along.
 *
 * Follows the mobile modal pattern (codebase-standards,
 * obsidian-mobiel-patroon.md): no layout measuring at open, no inline
 * styles, no silently disabled buttons, everything tappable answers.
 */

import { App, Modal, Setting } from "obsidian";
import type { LayoutChoice, RoundTripSettings } from "./settingsmodel";
import { HEADING_BREAK_LABELS, LAYOUT_PRESET_LABELS, sliderSpec } from "./settingschema";

export class LayoutChoiceModal extends Modal {
	private readonly choice: LayoutChoice;

	constructor(
		app: App,
		settings: RoundTripSettings,
		/** What is being sent, for the title: a note name, "folder …", "3 notes". */
		private readonly subject: string,
		private readonly onSend: (choice: LayoutChoice) => void,
	) {
		super(app);
		this.choice = {
			layoutPreset: settings.layoutPreset,
			fontSize: settings.fontSize,
			lineHeight: settings.lineHeight,
			margin: settings.margin,
			pageBreakAtHeading: settings.pageBreakAtHeading,
		};
	}

	onOpen(): void {
		this.render();
	}

	/** Re-rendered on preset change: the sliders only exist under Custom. */
	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(`Send ${this.subject} with layout`);

		new Setting(contentEl)
			.setName("Layout")
			.setDesc("For this send only — your saved settings stay as they are.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(LAYOUT_PRESET_LABELS)
					.setValue(this.choice.layoutPreset)
					.onChange((value) => {
						this.choice.layoutPreset = value as LayoutChoice["layoutPreset"];
						this.render();
					}),
			);

		if (this.choice.layoutPreset === "custom") {
			this.slider("Font size", "fontSize");
			this.slider("Line spacing", "lineHeight");
			this.slider("Margins", "margin");
		}

		new Setting(contentEl).setName("Start a new page at headings").addDropdown((dropdown) =>
			dropdown
				.addOptions(HEADING_BREAK_LABELS)
				.setValue(this.choice.pageBreakAtHeading)
				.onChange((value) => {
					this.choice.pageBreakAtHeading = value as LayoutChoice["pageBreakAtHeading"];
				}),
		);

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("Send")
					.setCta()
					.onClick(() => {
						this.close();
						this.onSend({ ...this.choice });
					}),
			)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
	}

	private slider(name: string, key: "fontSize" | "lineHeight" | "margin"): void {
		const spec = sliderSpec(key);
		new Setting(this.contentEl).setName(name).addSlider((slider) =>
			slider
				.setLimits(spec.min, spec.max, spec.step)
				.setValue(this.choice[key])
				.onChange((value) => {
					this.choice[key] = value;
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
