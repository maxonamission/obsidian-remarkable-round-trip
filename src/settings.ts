/**
 * The settings tab (PRD F1, F7, F9-basis).
 *
 * One declarative description: `getSettingDefinitions()` walks
 * `settingschema.ts`, which is also what puts these settings in the settings
 * search (GP_E4_S3). The imperative `display()` fallback for pre-1.13
 * versions was deleted when minAppVersion moved to 1.13.0 (GP_E5_S8) — its
 * deprecation warnings were kept standing as exactly this deletion list.
 */

import {
	App,
	ButtonComponent,
	PluginSettingTab,
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
	 * The declarative description; implementing this is also what makes these
	 * settings findable in the settings search (GP_E4_S3). See
	 * `settingschema.ts` for the screen-as-data it walks.
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
							new ButtonComponent(el)
								.setButtonText("Unpair")
								.setDestructive()
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

	private async pair(): Promise<void> {
		try {
			const client = this.plugin.createClient();
			const registration = await client.register(this.pairingCode);
			this.plugin.settings.deviceToken = registration.deviceToken;
			await this.plugin.saveSettings();
			notify("Paired with your reMarkable account.");
			// The pairing state changes both the Status text and which
			// controls exist — structural, so rebuild the definitions.
			this.update();
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
		this.update();
	}
}
