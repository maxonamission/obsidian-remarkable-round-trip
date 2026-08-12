import { describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	DEVICE_PAGE_SIZES,
	LAYOUT_PRESETS,
	breakLevelFor,
	layoutFor,
} from "../settingsmodel";

describe("layout presets (GP_E6_S3)", () => {
	it("custom uses the sliders as they are", () => {
		const settings = { ...DEFAULT_SETTINGS, fontSize: 12.5, lineHeight: 1.7, margin: 48 };
		expect(layoutFor(settings)).toEqual({ fontSize: 12.5, lineHeight: 1.7, margin: 48 });
	});

	it("a preset overrides the sliders with its bundle", () => {
		const settings = { ...DEFAULT_SETTINGS, layoutPreset: "compact" as const, fontSize: 14 };
		expect(layoutFor(settings)).toEqual(LAYOUT_PRESETS.compact);
	});

	it("presets stay within the sliders' own ranges", () => {
		for (const preset of Object.values(LAYOUT_PRESETS)) {
			expect(preset.fontSize).toBeGreaterThanOrEqual(9);
			expect(preset.fontSize).toBeLessThanOrEqual(14);
			expect(preset.lineHeight).toBeGreaterThanOrEqual(1.2);
			expect(preset.lineHeight).toBeLessThanOrEqual(1.9);
			expect(preset.margin).toBeGreaterThanOrEqual(24);
			expect(preset.margin).toBeLessThanOrEqual(64);
		}
	});
});

describe("device page sizes (GP_E6_S2)", () => {
	it("keeps the default on the reMarkable 1/2 screen", () => {
		expect(DEVICE_PAGE_SIZES[DEFAULT_SETTINGS.deviceModel]).toEqual({
			pageWidth: 447,
			pageHeight: 596,
		});
	});

	it("keeps every screen at 3:4 portrait, the shape the ink transform assumes", () => {
		// The Paper Pro Move (9:16) is deliberately absent: its aspect would
		// make the device-to-page mapping anisotropic (see settingsmodel.ts).
		for (const { pageWidth, pageHeight } of Object.values(DEVICE_PAGE_SIZES)) {
			expect(pageWidth / pageHeight).toBeGreaterThan(0.73);
			expect(pageWidth / pageHeight).toBeLessThan(0.77);
		}
	});
});

describe("heading-break level (GP_E6_S4)", () => {
	it("maps the setting to the typesetter's level, defaulting to manual only", () => {
		expect(breakLevelFor(DEFAULT_SETTINGS)).toBe(0);
		expect(breakLevelFor({ ...DEFAULT_SETTINGS, pageBreakAtHeading: "h1" })).toBe(1);
		expect(breakLevelFor({ ...DEFAULT_SETTINGS, pageBreakAtHeading: "h2" })).toBe(2);
	});
});
