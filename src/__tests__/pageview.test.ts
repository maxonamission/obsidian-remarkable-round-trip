import { describe, expect, it } from "vitest";
import { describePageView, parsePageView } from "../incoming/pageview";

describe("parsePageView", () => {
	it("reads the zoom fields the device records for a PDF", () => {
		const view = parsePageView(
			JSON.stringify({
				zoomMode: "customFit",
				customZoomScale: 1.2,
				customZoomCenterX: 0,
				customZoomCenterY: 936,
				customZoomPageWidth: 1404,
				customZoomPageHeight: 1872,
				cPages: { pages: [{ id: "p1" }] },
			}),
		);
		expect(view).toMatchObject({
			zoomMode: "customFit",
			scale: 1.2,
			centerY: 936,
			pageHeight: 1872,
		});
	});

	it("keeps the transform matrix when the document carries one", () => {
		const view = parsePageView(JSON.stringify({ transform: { m22: 1, m32: -174, m33: 1 } }));
		expect(view?.transform).toEqual({ m22: 1, m32: -174, m33: 1 });
	});

	it("collects unrecognised view-ish fields rather than dropping them", () => {
		// The point is diagnosis: a firmware may name the offset something we
		// have never seen, and a field we discard is a field we cannot ask about.
		const view = parsePageView(
			JSON.stringify({ pageCropMargin: 42, textScale: 1, author: "x" }),
		);
		expect(view?.extra).toEqual({ pageCropMargin: 42, textScale: 1 });
		expect(view?.extra.author).toBeUndefined();
	});

	it("survives a .content that is not JSON at all", () => {
		expect(parsePageView("<html>")).toBeNull();
		expect(parsePageView("null")).toBeNull();
	});
});

describe("describePageView", () => {
	it("renders one readable line for the report", () => {
		const line = describePageView(
			parsePageView(JSON.stringify({ zoomMode: "bestFit", customZoomScale: 1 })),
		);
		expect(line).toBe("mode bestFit, scale 1");
	});

	it("says nothing when the document records nothing about the view", () => {
		expect(describePageView(parsePageView("{}"))).toBe("");
		expect(describePageView(null)).toBe("");
	});
});
