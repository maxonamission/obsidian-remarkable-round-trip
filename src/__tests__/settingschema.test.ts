import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, extrasFrom, settingsFrom, storedFrom } from "../settingsmodel";
import { sliderSpec } from "../settingschema";
import {
	SETTING_SECTIONS,
	checkEndpoint,
	cleanPath,
	conditionsOf,
	isVisible,
	readSetting,
	writeSetting,
} from "../settingschema";

const specs = SETTING_SECTIONS.flatMap((section) => section.items);

describe("the settings schema", () => {
	it("names a real setting for every control", () => {
		// GP_E4_S3: the schema feeds both renderers, so a key that does not
		// exist would silently produce a control that reads and writes nothing.
		for (const spec of specs) {
			expect(readSetting(DEFAULT_SETTINGS, spec.key), spec.key).toBeDefined();
		}
	});

	it("covers every setting a user can change", () => {
		// The counterpart: a setting added to the model but not to the schema
		// would be invisible in both renderers.
		// lastSeenVersion is bookkeeping for the update notice (GP_E5_S3), not
		// a user choice — only its showUpdateNotice toggle belongs in the UI.
		const internal = new Set(["deviceToken", "mappings", "lastSeenVersion"]);
		const described = new Set(specs.map((spec) => spec.key.split(".")[0]));
		for (const key of Object.keys(DEFAULT_SETTINGS)) {
			if (internal.has(key)) continue;
			expect(described.has(key), `${key} is not in the settings schema`).toBe(true);
		}
	});

	it("keeps Connection first, where both renderers expect it", () => {
		// Both renderers put the pairing controls under the first section's
		// heading and continue with its schema settings; reordering the
		// sections would silently split that section in two.
		expect(SETTING_SECTIONS[0].heading).toBe("Connection");
	});

	it("only hides a setting behind a condition that can be met", () => {
		for (const spec of specs) {
			for (const condition of conditionsOf(spec)) {
				expect(readSetting(DEFAULT_SETTINGS, condition.key), spec.key).toBeDefined();
			}
		}
	});

	it("refreshes the tab exactly for the settings others depend on", () => {
		// A conditional setting whose controlling setting does not redraw the
		// tab would appear only after closing and reopening settings.
		const controllers = new Set(
			specs.flatMap((spec) => conditionsOf(spec).map((condition) => condition.key)),
		);
		for (const spec of specs) {
			if (!controllers.has(spec.key)) continue;
			expect(spec.refresh, `${spec.key} reveals other settings`).toBe(true);
		}
	});

	it("offers the stored value among a dropdown's options", () => {
		for (const spec of specs) {
			if (spec.control.type !== "dropdown") continue;
			const current = String(readSetting(DEFAULT_SETTINGS, spec.key));
			expect(Object.keys(spec.control.options), spec.key).toContain(current);
		}
	});

	it("keeps every default inside its slider's range", () => {
		for (const spec of specs) {
			if (spec.control.type !== "slider") continue;
			const value = Number(readSetting(DEFAULT_SETTINGS, spec.key));
			expect(value, spec.key).toBeGreaterThanOrEqual(spec.control.min);
			expect(value, spec.key).toBeLessThanOrEqual(spec.control.max);
		}
	});
});

describe("reading and writing by dotted key", () => {
	it("reaches a nested setting", () => {
		expect(readSetting(DEFAULT_SETTINGS, "markStyles.circle")).toBe("bold");
	});

	it("writes without mutating the original", () => {
		const updated = writeSetting(DEFAULT_SETTINGS, "markStyles.circle", "highlight");
		expect(updated.markStyles.circle).toBe("highlight");
		expect(DEFAULT_SETTINGS.markStyles.circle).toBe("bold");
		// Untouched branches come along unchanged.
		expect(updated.markStyles.strikethrough).toBe("strikethrough");
		expect(updated.outputFormat).toBe(DEFAULT_SETTINGS.outputFormat);
	});

	it("answers undefined for a key that is not there", () => {
		expect(readSetting(DEFAULT_SETTINGS, "nietBestaand.diep")).toBeUndefined();
	});
});

describe("visibility", () => {
	it("hides the endpoint URL until the self-hosted toggle is on", () => {
		const spec = specs.find((item) => item.key === "customEndpointUrl")!;
		expect(isVisible(spec, DEFAULT_SETTINGS)).toBe(false);
		expect(isVisible(spec, { ...DEFAULT_SETTINGS, useCustomEndpoint: true })).toBe(true);
	});

	it("hides the typography sliders for EPUB, which reflows on the device", () => {
		const spec = specs.find((item) => item.key === "fontSize")!;
		expect(isVisible(spec, DEFAULT_SETTINGS)).toBe(true);
		expect(isVisible(spec, { ...DEFAULT_SETTINGS, outputFormat: "epub" })).toBe(false);
	});
});

describe("input cleanup", () => {
	it("strips slashes and spaces from a folder path", () => {
		expect(cleanPath("  /reMarkable-in/  ")).toBe("reMarkable-in");
	});

	it("rejects an endpoint without a scheme, and allows http for a LAN server", () => {
		expect(checkEndpoint("rm.example.org")).toContain("https://");
		expect(checkEndpoint("http://192.168.1.10")).toBeUndefined();
		expect(checkEndpoint("https://rm.example.org")).toBeUndefined();
		// Empty is fine: the toggle is on but the URL has not been typed yet.
		expect(checkEndpoint("")).toBeUndefined();
	});
});

describe("sliderSpec (GP_E6_S10)", () => {
	it("finds the three layout sliders the modal depends on", () => {
		// A schema rename would otherwise only surface when a user opens the
		// layout modal and picks Custom.
		for (const key of ["fontSize", "lineHeight", "margin"] as const) {
			const spec = sliderSpec(key);
			expect(spec.min).toBeLessThan(spec.max);
			expect(spec.step).toBeGreaterThan(0);
		}
	});

	it("throws loudly for a key that is not a slider", () => {
		expect(() => sliderSpec("layoutPreset")).toThrow(/No slider spec/);
	});
});

describe("unknown data.json keys survive a save (GP_E7_S1 bevinding, 0.35.1)", () => {
	it("carries hand-added keys through the exact save composition", () => {
		const stored = { deviceToken: "t", spikeSchrijfmodus: true, toekomstig: 42 };
		const extras = extrasFrom(stored);
		expect(extras).toEqual({ spikeSchrijfmodus: true, toekomstig: 42 });
		// storedFrom IS the save path (main.ts saveSettings calls it): extras
		// first, settings win on overlap.
		const saved = storedFrom(settingsFrom(stored), extras);
		expect(saved.spikeSchrijfmodus).toBe(true);
		expect(saved.deviceToken).toBe("t");
	});

	it("lets a later-learned setting win over a stale extra of the same name", () => {
		const saved = storedFrom(settingsFrom({}), { deviceToken: "stale" });
		expect(saved.deviceToken).toBe("");
	});

	it("returns nothing for a data.json holding only known settings", () => {
		expect(extrasFrom({ ...DEFAULT_SETTINGS })).toEqual({});
	});
});
