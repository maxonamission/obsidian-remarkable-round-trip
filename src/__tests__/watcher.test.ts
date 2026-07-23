import { describe, expect, it } from "vitest";
import { WatchQueue, isInWatchFolder } from "../sync/watcher";

/** Manual timer harness: fire() runs all due timers. */
function fakeTimers() {
	let nextId = 1;
	const timers = new Map<number, () => void>();
	return {
		setTimer: (fn: () => void, _ms: number) => {
			const id = nextId++;
			timers.set(id, fn);
			return id;
		},
		clearTimer: (id: number) => void timers.delete(id),
		fire: () => {
			const due = [...timers.values()];
			timers.clear();
			due.forEach((fn) => fn());
		},
		pending: () => timers.size,
	};
}

describe("isInWatchFolder", () => {
	it("matches the folder itself and nested paths only", () => {
		expect(isInWatchFolder("reMarkable-out/a.md", "reMarkable-out")).toBe(true);
		expect(isInWatchFolder("reMarkable-out/sub/b.md", "reMarkable-out")).toBe(true);
		expect(isInWatchFolder("reMarkable-outtakes/c.md", "reMarkable-out")).toBe(false);
		expect(isInWatchFolder("elders/d.md", "reMarkable-out")).toBe(false);
		expect(isInWatchFolder("x.md", "")).toBe(false);
	});
});

describe("WatchQueue", () => {
	it("debounces repeated changes into one send", () => {
		const timers = fakeTimers();
		const ready: string[] = [];
		const queue = new WatchQueue({
			folder: "out",
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (p) => ready.push(p),
		});
		queue.noteChanged("out/nota.md");
		queue.noteChanged("out/nota.md");
		queue.noteChanged("out/nota.md");
		expect(timers.pending()).toBe(1);
		timers.fire();
		expect(ready).toEqual(["out/nota.md"]);
	});

	it("ignores non-markdown files and files outside the folder", () => {
		const timers = fakeTimers();
		const queue = new WatchQueue({
			folder: "out",
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: () => {},
		});
		queue.noteChanged("out/plaatje.png");
		queue.noteChanged("elders/nota.md");
		expect(timers.pending()).toBe(0);
	});

	it("cancels a pending send when the file is removed, and all on dispose", () => {
		const timers = fakeTimers();
		const ready: string[] = [];
		const queue = new WatchQueue({
			folder: "out",
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (p) => ready.push(p),
		});
		queue.noteChanged("out/a.md");
		queue.noteRemoved("out/a.md");
		queue.noteChanged("out/b.md");
		queue.dispose();
		timers.fire();
		expect(ready).toEqual([]);
	});
});
