import { describe, expect, it } from "vitest";
import type { ProgressHandle } from "../notify";
import { SyncActivity } from "../sync/activity";

/** A stand-in for the status bar or notice: records what it was told. */
function fakeHandle() {
	const shown: string[] = [];
	let hidden = false;
	const handle: ProgressHandle = {
		setMessage: (message) => void shown.push(message),
		hide: () => {
			hidden = true;
		},
	};
	return { handle, shown, isHidden: () => hidden };
}

describe("SyncActivity (GP_E5_S31)", () => {
	it("records what the progress handle shows, and passes it on", () => {
		const activity = new SyncActivity(() => 1000);
		const bar = fakeHandle();
		const tracked = activity.track(bar.handle, "Preparing 3 notes…");
		expect(activity.snapshot()).toEqual({ message: "Preparing 3 notes…", since: 1000 });

		tracked.setMessage("Reading your reMarkable library 12/340…", { done: 12, total: 340 });
		expect(bar.shown).toEqual(["Reading your reMarkable library 12/340…"]);
		expect(activity.snapshot()).toEqual({
			message: "Reading your reMarkable library 12/340…",
			count: { done: 12, total: 340 },
			since: 1000,
		});

		tracked.hide();
		expect(bar.isHidden()).toBe(true);
		expect(activity.snapshot()).toBeNull();
	});

	it("lets the newest operation win: an older handle cannot change or clear it", () => {
		const activity = new SyncActivity();
		const first = activity.track(fakeHandle().handle, "Sending 1/2 to reMarkable…");
		activity.track(fakeHandle().handle, "Checking 40 document(s) for annotations…");

		first.setMessage("Sending 2/2 to reMarkable…");
		expect(activity.snapshot()?.message).toBe("Checking 40 document(s) for annotations…");
		first.hide();
		expect(activity.snapshot()?.message).toBe("Checking 40 document(s) for annotations…");
	});
});
