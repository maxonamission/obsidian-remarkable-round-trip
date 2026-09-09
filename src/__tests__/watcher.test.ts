import { describe, expect, it } from "vitest";
import { WatchBatch, WatchQueue, isInWatchFolder } from "../sync/watcher";

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
		expect(isInWatchFolder("reMarkable-out/sub/b.md", "reMarkable-out")).toBe(
			true,
		);
		expect(isInWatchFolder("reMarkable-outtakes/c.md", "reMarkable-out")).toBe(
			false,
		);
		expect(isInWatchFolder("elders/d.md", "reMarkable-out")).toBe(false);
		expect(isInWatchFolder("x.md", "")).toBe(false);
	});
});

describe("WatchQueue", () => {
	it("debounces repeated changes into one send", () => {
		const timers = fakeTimers();
		const ready: WatchBatch[] = [];
		const queue = new WatchQueue({
			folder: "out",
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (batch) => ready.push(batch),
		});
		queue.noteChanged("out/nota.md");
		queue.noteChanged("out/nota.md");
		queue.noteChanged("out/nota.md");
		expect(timers.pending()).toBe(1);
		timers.fire();
		expect(ready).toEqual([{ changed: ["out/nota.md"], removed: [] }]);
	});

	it("coalesces different notes into one deduplicated batch", () => {
		const timers = fakeTimers();
		const ready: WatchBatch[] = [];
		const queue = new WatchQueue({
			folder: "out",
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (batch) => ready.push(batch),
		});
		queue.noteChanged("out/a.md");
		queue.noteChanged("out/b.md");
		queue.noteChanged("out/a.md");

		expect(timers.pending()).toBe(1);
		timers.fire();
		expect(ready).toEqual([{ changed: ["out/a.md", "out/b.md"], removed: [] }]);
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

	it("tracks a local deletion in the same batch", () => {
		const timers = fakeTimers();
		const ready: WatchBatch[] = [];
		const queue = new WatchQueue({
			folder: "out",
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (batch) => ready.push(batch),
		});
		queue.noteChanged("out/a.md");
		queue.noteRemoved("out/a.md");
		timers.fire();
		expect(ready).toEqual([{ changed: [], removed: ["out/a.md"] }]);
	});

	it("coalesces an in-folder rename as one changed path", () => {
		const timers = fakeTimers();
		const ready: WatchBatch[] = [];
		const queue = new WatchQueue({
			folder: "out",
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (batch) => ready.push(batch),
		});
		queue.noteRenamed("out/a.md", "out/sub/a.md");
		timers.fire();
		expect(ready).toEqual([{ changed: ["out/sub/a.md"], removed: [] }]);
	});

	it("treats a rename out of the watch folder as a removal", () => {
		const timers = fakeTimers();
		const ready: WatchBatch[] = [];
		const queue = new WatchQueue({
			folder: "out",
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (batch) => ready.push(batch),
		});
		queue.noteRenamed("out/a.md", "archive/a.md");
		timers.fire();
		expect(ready).toEqual([{ changed: [], removed: ["out/a.md"] }]);
	});

	it("continues tracking a synced note when it moves outside the watch folder", () => {
		const timers = fakeTimers();
		const ready: WatchBatch[] = [];
		const queue = new WatchQueue({
			folder: "out",
			isTracked: (path) => path === "out/a.md",
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (batch) => ready.push(batch),
		});
		queue.noteRenamed("out/a.md", "archive/a.md");
		timers.fire();
		expect(ready).toEqual([{ changed: ["archive/a.md"], removed: [] }]);
	});

	it("watches a previously synced note outside the configured folder", () => {
		const timers = fakeTimers();
		const ready: WatchBatch[] = [];
		const queue = new WatchQueue({
			folder: "out",
			isTracked: (path) => path === "archive/a.md",
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (batch) => ready.push(batch),
		});
		queue.noteChanged("archive/a.md");
		timers.fire();
		expect(ready).toEqual([{ changed: ["archive/a.md"], removed: [] }]);
	});

	it("cancels all pending work on dispose", () => {
		const timers = fakeTimers();
		const ready: WatchBatch[] = [];
		const queue = new WatchQueue({
			folder: "out",
			debounceMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
			onReady: (batch) => ready.push(batch),
		});
		queue.noteChanged("out/b.md");
		queue.dispose();
		timers.fire();
		expect(ready).toEqual([]);
	});
});
