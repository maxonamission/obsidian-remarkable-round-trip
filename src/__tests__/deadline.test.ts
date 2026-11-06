import { describe, expect, it } from "vitest";
import { DeadlineTimers, withDeadline } from "../deadline";
import { HttpClient, timedHttp } from "../transport/http";

/** Manual timers: tests fire the deadline themselves (GP_E5_S27). */
function manualTimers() {
	const pending = new Map<number, () => void>();
	let next = 1;
	const timers: DeadlineTimers = {
		setTimer: (fn) => {
			const id = next++;
			pending.set(id, fn);
			return id;
		},
		clearTimer: (id) => {
			pending.delete(id);
		},
	};
	const fireAll = () => {
		for (const [id, fn] of [...pending]) {
			pending.delete(id);
			fn();
		}
	};
	return { timers, pending, fireAll };
}

describe("withDeadline (GP_E5_S27)", () => {
	it("passes a result through and clears its timer", async () => {
		const { timers, pending } = manualTimers();
		await expect(
			withDeadline(Promise.resolve("ok"), 1_000, "too slow", timers),
		).resolves.toBe("ok");
		expect(pending.size).toBe(0);
	});

	it("passes a failure through and clears its timer", async () => {
		const { timers, pending } = manualTimers();
		await expect(
			withDeadline(Promise.reject(new Error("boom")), 1_000, "too slow", timers),
		).rejects.toThrow("boom");
		expect(pending.size).toBe(0);
	});

	it("turns a wait that never settles into an error at the deadline", async () => {
		const { timers, fireAll } = manualTimers();
		const never = new Promise<string>(() => undefined);
		const bounded = withDeadline(never, 1_000, "the page could not be encoded", timers);
		fireAll();
		await expect(bounded).rejects.toThrow("the page could not be encoded");
	});

	it("ignores a late result once the deadline has passed", async () => {
		const { timers, fireAll } = manualTimers();
		let finish: ((value: string) => void) | undefined;
		const late = new Promise<string>((resolve) => (finish = resolve));
		const bounded = withDeadline(late, 1_000, "too slow", timers);
		fireAll();
		finish?.("late");
		await expect(bounded).rejects.toThrow("too slow");
	});
});

describe("timedHttp (GP_E5_S27)", () => {
	it("abandons a request on the simple endpoint that never answers", async () => {
		const { timers, fireAll } = manualTimers();
		const hanging: HttpClient = () => new Promise(() => undefined);
		const request = timedHttp(hanging, 300_000, timers)({
			url: "https://internal.cloud.remarkable.com/doc/v2/files",
			method: "POST",
		});
		fireAll();
		await expect(request).rejects.toThrow(
			"reMarkable request did not complete within 300s and was abandoned.",
		);
	});

	it("leaves a request that answers in time untouched", async () => {
		const { timers } = manualTimers();
		const ok: HttpClient = () =>
			Promise.resolve({ status: 200, headers: {}, text: "done" });
		await expect(
			timedHttp(ok, 300_000, timers)({ url: "https://x", method: "GET" }),
		).resolves.toMatchObject({ status: 200, text: "done" });
	});
});
