/**
 * The settings tab (PRD F1, F7, F9-basis).
 *
 * Two renderings of one description: `getSettingDefinitions()` for Obsidian
 * 1.13+, which is what puts these settings in the settings search, and
 * `display()` for everything before it. Both walk `settingschema.ts`, so a
 * new setting appears in both without anyone remembering to do it twice
 * (GP_E4_S3).
 */

import {
	App,
	ButtonComponent,
	PluginSettingTab,
	Setting,
	type SettingDefinition,
	type SettingDefinitionItem,
} from "obsidian";
import { notify } from "./notify";
import type RoundTripPlugin from "./main";
// One address for "the settings": the model lives in its own module so the
// schema and the projection can use it without the Obsidian API, but
// importers need not care (GP_E4_S3).
export * from "./settingsmodel";
import { TransportError } from "./transport/http";
import {
	SETTING_SECTIONS,
	type SettingSpec,
	checkEndpoint,
	cleanPath,
	isVisible,
	readSetting,
	writeSetting,
} from "./settingschema";

/** Not a stored setting: the one-time code lives only until pairing. */
const PAIRING_CODE_KEY = "__pairingCode";

/** Folder paths are stored trimmed and without leading or trailing slashes. */
function sanitise(key: string, value: unknown): unknown {
	if (typeof value !== "string") return value;
	return key.toLowerCase().includes("folder") || key === "customEndpointUrl"
		? cleanPath(value)
		: value;
}

export class RoundTripSettingTab extends PluginSettingTab {
	private pairingCode = "";

	constructor(
		app: App,
		private readonly plugin: RoundTripPlugin,
	) {
		super(app, plugin);
	}

	/**
	 * The declarative description (Obsidian 1.13+). Implementing this is what
	 * makes these settings findable in the settings search; `display()` below
	 * renders the same declaration for every earlier version, which is where
	 * the owner is (1.12.7). One description, two renderers — see
	 * `settingschema.ts` (GP_E4_S3).
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const groups: SettingDefinitionItem[] = [
			{
				type: "group",
				heading: "Connection",
				items: [
					{
						name: "Status",
						desc: this.pairingStatus(),
					},
					{
						name: "Pair with one-time code",
						desc: "Enter the 8-letter code, then select Pair.",
						visible: () => !this.paired,
						control: { type: "text", key: PAIRING_CODE_KEY, placeholder: "abcdefgh" },
					},
					{
						name: "Pair",
						desc: "Exchange the code for a device token.",
						visible: () => !this.paired,
						action: (el) => {
							new ButtonComponent(el)
								.setButtonText("Pair")
								.setCta()
								.onClick(() => void this.pair());
						},
					},
					{
						name: "Unpair",
						desc: "Forget the stored device token.",
						visible: () => this.paired,
						action: (el) => {
							// setWarning, not setDestructive: the latter needs 1.13 and
							// minAppVersion is 1.7.2, so the project's lint rules
							// (rightly) forbid it. setWarning still works there.
							new ButtonComponent(el)
								.setButtonText("Unpair")
								.setWarning()
								.onClick(() => void this.unpair());
						},
					},
					...SETTING_SECTIONS[0].items.map((spec) => this.defineSetting(spec)),
				],
			},
		];

		for (const section of SETTING_SECTIONS.slice(1)) {
			groups.push({
				type: "group",
				heading: section.heading,
				items: [
					...(section.note === undefined
						? []
						: [{ name: section.heading, desc: section.note, searchable: false }]),
					...section.items.map((spec) => this.defineSetting(spec)),
				],
			});
		}
		return groups;
	}

	/** One schema entry as a declarative definition. */
	private defineSetting(spec: SettingSpec): SettingDefinition {
		const base = {
			name: spec.name,
			desc: spec.desc,
			visible: () => isVisible(spec, this.plugin.settings),
		};
		switch (spec.control.type) {
			case "toggle":
				return { ...base, control: { type: "toggle", key: spec.key } };
			case "dropdown":
				return {
					...base,
					control: { type: "dropdown", key: spec.key, options: spec.control.options },
				};
			case "slider":
				return {
					...base,
					control: {
						type: "slider",
						key: spec.key,
						min: spec.control.min,
						max: spec.control.max,
						step: spec.control.step,
					},
				};
			default:
				return {
					...base,
					control: {
						type: "text",
						key: spec.key,
						placeholder: spec.control.placeholder,
						validate:
							spec.control.sanitise === "url"
								? (value: string) => checkEndpoint(value)
								: undefined,
					},
				};
		}
	}

	/** Obsidian 1.13+ reads values through here; dotted keys reach nested ones. */
	getControlValue(key: string): unknown {
		if (key === PAIRING_CODE_KEY) return this.pairingCode;
		return readSetting(this.plugin.settings, key);
	}

	/** …and writes them through here, applying the same cleanup as `display()`. */
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === PAIRING_CODE_KEY) {
			this.pairingCode = String(value);
			return;
		}
		this.plugin.settings = writeSetting(this.plugin.settings, key, sanitise(key, value));
		await this.plugin.saveSettings();
	}

	private get paired(): boolean {
		return this.plugin.settings.deviceToken !== "";
	}

	private pairingStatus(): string {
		return this.paired
			? "Paired with a reMarkable account."
			: "Not paired. Get a one-time code at my.remarkable.com/device/browser/connect.";
	}

	/**
	 * The imperative rendering, for Obsidian below 1.13. It walks the same
	 * declaration, so a setting added to the schema turns up in both without
	 * anyone remembering to do it twice.
	 *
	 * Everything in here is deprecated as of 1.13 — that is the point: this is
	 * the path for versions that have nothing newer. Those deprecation
	 * warnings are left standing rather than silenced: they are true, and the
	 * day minAppVersion moves to 1.13 they are the list of what to delete.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Connection").setHeading();
		new Setting(containerEl).setName("Status").setDesc(this.pairingStatus());

		if (!this.paired) {
			new Setting(containerEl)
				.setName("Pair with one-time code")
				.setDesc("Enter the 8-letter code, then select Pair.")
				.addText((text) =>
					text.setPlaceholder("abcdefgh").onChange((value) => {
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
					// setWarning, not setDestructive: the latter arrived in 1.13 and
					// minAppVersion is 1.7.2. This branch only runs below 1.13.
					button
						.setButtonText("Unpair")
						.setWarning()
						.onClick(() => void this.unpair()),
				);
		}

		SETTING_SECTIONS.forEach((section, index) => {
			// The connection heading is already up, with the pairing controls
			// under it; its schema settings continue in the same section.
			if (index > 0) new Setting(containerEl).setName(section.heading).setHeading();
			if (section.note !== undefined) new Setting(containerEl).setDesc(section.note);
			for (const spec of section.items) {
				if (!isVisible(spec, this.plugin.settings)) continue;
				this.renderSetting(containerEl, spec);
			}
		});
	}

	/** One schema entry, rendered with the pre-1.13 builder. */
	private renderSetting(containerEl: HTMLElement, spec: SettingSpec): void {
		const setting = new Setting(containerEl).setName(spec.name).setDesc(spec.desc);
		const commit = async (value: unknown): Promise<void> => {
			this.plugin.settings = writeSetting(this.plugin.settings, spec.key, value);
			await this.plugin.saveSettings();
			if (spec.refresh === true) this.display();
		};
		const current = readSetting(this.plugin.settings, spec.key);

		switch (spec.control.type) {
			case "toggle":
				setting.addToggle((toggle) =>
					toggle.setValue(current === true).onChange((value) => void commit(value)),
				);
				return;
			case "dropdown": {
				const options = spec.control.options;
				setting.addDropdown((dropdown) => {
					for (const [value, label] of Object.entries(options)) {
						dropdown.addOption(value, label);
					}
					dropdown.setValue(String(current)).onChange((value) => void commit(value));
				});
				return;
			}
			case "slider": {
				const { min, max, step } = spec.control;
				setting.addSlider((slider) =>
					slider
						.setLimits(min, max, step)
						.setValue(Number(current))
						// setDynamicTooltip is deprecated in 1.13, where this renderer
						// no longer runs; below it the value is not shown otherwise.
						.setDynamicTooltip()
						.onChange((value) => void commit(value)),
				);
				return;
			}
			default: {
				const { placeholder, sanitise: mode } = spec.control;
				setting.addText((text) =>
					text
						.setPlaceholder(placeholder ?? "")
						.setValue(typeof current === "string" ? current : "")
						.onChange((value) => {
							if (mode === "url") {
								const problem = checkEndpoint(value);
								if (problem !== undefined) {
									notify(problem);
									return;
								}
							}
							void commit(sanitise(spec.key, value));
						}),
				);
			}
		}
	}

	private async pair(): Promise<void> {
		try {
			const client = this.plugin.createClient();
			const registration = await client.register(this.pairingCode);
			this.plugin.settings.deviceToken = registration.deviceToken;
			await this.plugin.saveSettings();
			notify("Paired with your reMarkable account.");
			this.display();
		} catch (error) {
			notify(
				error instanceof TransportError
					? error.message
					: "Pairing failed — check your connection and try again.",
			);
		}
	}

	private async unpair(): Promise<void> {
		this.plugin.settings.deviceToken = "";
		await this.plugin.saveSettings();
		notify("Device token removed.");
		this.display();
	}
}
