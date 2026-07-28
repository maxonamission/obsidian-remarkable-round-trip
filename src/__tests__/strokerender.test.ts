import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRmLines, Stroke } from "../incoming/rmlines";
import { PainterContext, paintPlan, planRender, strokeColor } from "../incoming/strokerender";

const realPage = new Uint8Array(
	readFileSync(fileURLToPath(new URL("./fixtures/lines-v2.rm", import.meta.url))),
);

const stroke = (points: { x: number; y: number }[]): Stroke => ({
	tool: 15,
	color: 0,
	thicknessScale: 1,
	points: points.map((p) => ({ ...p, width: 20, pressure: 100 })),
});

/** Records the calls a painter makes, so painting is testable headlessly. */
function recordingContext() {
	const calls: string[] = [];
	const context: PainterContext = {
		lineCap: "butt",
		lineJoin: "miter",
		strokeStyle: "",
		lineWidth: 0,
		fillStyle: "",
		beginPath: () => calls.push("begin"),
		moveTo: (x, y) => calls.push(`move ${Math.round(x)},${Math.round(y)}`),
		lineTo: (x, y) => calls.push(`line ${Math.round(x)},${Math.round(y)}`),
		stroke: () => calls.push("stroke"),
		fillRect: (x, y, w, h) => calls.push(`fill ${w}x${h}`),
	};
	return { context, calls };
}

describe("planRender", () => {
	it("returns nothing when there is no ink", () => {
		expect(planRender([])).toBeNull();
		expect(planRender([stroke([])])).toBeNull();
	});

	it("crops to the ink so handwriting is not lost on a mostly empty page", () => {
		const plan = planRender(
			[
				stroke([
					{ x: 100, y: 200 },
					{ x: 140, y: 220 },
				]),
			],
			{
				padding: 10,
				maxSize: 1000,
			},
		);
		expect(plan).not.toBeNull();
		// Ink is 40x20 plus 10 padding on each side → 60x40 at scale 1.5 (capped).
		expect(plan?.width).toBe(90);
		expect(plan?.height).toBe(60);
	});

	it("renders the whole page when cropping is off, scaled to fit maxSize", () => {
		const plan = planRender(
			[
				stroke([
					{ x: 0, y: 0 },
					{ x: 10, y: 10 },
				]),
			],
			{
				crop: false,
				maxSize: 1404,
			},
		);
		// The page is 1404x1872; the longest edge is capped, aspect preserved.
		expect(plan?.height).toBe(1404);
		expect(plan?.width).toBe(1053);
	});

	it("keeps the image within the requested maximum size", () => {
		const plan = planRender(
			[
				stroke([
					{ x: -700, y: 0 },
					{ x: 700, y: 1800 },
				]),
			],
			{
				maxSize: 800,
			},
		);
		expect(Math.max(plan?.width ?? 0, plan?.height ?? 0)).toBeLessThanOrEqual(800);
	});

	it("never produces a hairline-thin path", () => {
		const plan = planRender([
			{
				...stroke([
					{ x: 0, y: 0 },
					{ x: 5, y: 5 },
				]),
				thicknessScale: 0.0001,
			},
		]);
		expect(plan?.paths[0].width).toBeGreaterThanOrEqual(1);
	});

	it("ignores non-finite coordinates instead of collapsing the bounds", () => {
		const broken = stroke([
			{ x: Number.NaN, y: 0 },
			{ x: 10, y: 10 },
			{ x: 20, y: 30 },
		]);
		const plan = planRender([broken], { padding: 0, maxSize: 100 });
		expect(plan).not.toBeNull();
		expect(plan?.paths[0].points).toHaveLength(2);
	});

	it("plans a real page from the device", () => {
		const plan = planRender(parseRmLines(realPage));
		expect(plan).not.toBeNull();
		expect(plan?.paths).toHaveLength(10);
		expect(plan?.width).toBeGreaterThan(10);
		expect(plan?.height).toBeGreaterThan(10);
	});
});

describe("paintPlan", () => {
	it("fills a white background and draws every path", () => {
		const plan = planRender([
			stroke([
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
			]),
			stroke([
				{ x: 0, y: 10 },
				{ x: 10, y: 10 },
			]),
		]);
		const { context, calls } = recordingContext();
		paintPlan(context, plan!);
		expect(calls[0]).toMatch(/^fill /);
		expect(calls.filter((c) => c === "stroke")).toHaveLength(2);
		expect(context.lineCap).toBe("round");
	});

	it("still draws a single-point stroke (a dot)", () => {
		const plan = planRender([stroke([{ x: 5, y: 5 }])]);
		const { context, calls } = recordingContext();
		paintPlan(context, plan!);
		expect(calls.filter((c) => c.startsWith("line"))).toHaveLength(1);
	});
});

describe("strokeColor", () => {
	it("maps known pen colours and falls back to black", () => {
		expect(strokeColor(0)).toBe("#000000");
		expect(strokeColor(6)).toBe("#1565c0");
		expect(strokeColor(999)).toBe("#000000");
	});
});
