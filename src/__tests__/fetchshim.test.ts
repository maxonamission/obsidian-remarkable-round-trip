import { afterEach, describe, expect, it } from "vitest";
import {
	installFetchShim,
	isTransientTransportError,
	ShimTransport,
} from "../transport/fetchshim";

const HOSTS = ["https://eu.tectonic.remarkable.com"];
const SCOPE = globalThis as unknown as { fetch: typeof fetch };

// The shim patches a window; tests have none, so they hand it their own
// scope explicitly rather than reaching for a shared global (GP_E3_S22).
// The inert timers keep the timeout valve out of tests that don't exercise
// it — the valve test injects live ones.
const NO_WAIT = {
	scope: SCOPE,
	backoffMs: () => 0,
	sleep: () => Promise.resolve(),
	setTimer: () => 0,
	clearTimer: () => undefined,
};

let restore: (() => void) | null = null;
afterEach(() => {
	restore?.();
	restore = null;
});

/** Let every pending microtask chain (acquire, body conversion) run out. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function okResponse(text = "ok") {
	const bytes = new TextEncoder().encode(text);
	return {
		status: 200,
		headers: {},
		arrayBuffer: bytes.buffer.slice(0),
	};
}

describe("isTransientTransportError", () => {
	it("recognises the Android okhttp connection failure", () => {
		expect(
			isTransientTransportError(
				new Error(
					"Request Failed. IOException unexpected end of stream on com.android.okhttp.Address@6558e99b",
				),
			),
		).toBe(true);
	});

	it("recognises other connection-level failures", () => {
		expect(isTransientTransportError(new Error("ECONNRESET"))).toBe(true);
		expect(isTransientTransportError(new Error("socket hang up"))).toBe(true);
	});

	it("recognises Electron's request-flood rejection (GP_E5_S9)", () => {
		expect(
			isTransientTransportError(new Error("net::ERR_INSUFFICIENT_RESOURCES")),
		).toBe(true);
	});

	it("does not treat application errors as transient", () => {
		expect(isTransientTransportError(new Error("Pairing code was rejected"))).toBe(false);
	});
});

describe("installFetchShim retries", () => {
	it("retries a transient failure and succeeds", async () => {
		let calls = 0;
		const transport: ShimTransport = () => {
			calls++;
			if (calls < 3) {
				return Promise.reject(
					new Error("unexpected end of stream on com.android.okhttp.Address@1"),
				);
			}
			return Promise.resolve(okResponse("recovered"));
		};
		const handle = installFetchShim(HOSTS, transport, NO_WAIT);
		restore = handle.restore;

		const response = await fetch(`${HOSTS[0]}/sync/v4/root`);
		expect(await response.text()).toBe("recovered");
		expect(calls).toBe(3);
	});

	it("gives up after the configured attempts", async () => {
		let calls = 0;
		const transport: ShimTransport = () => {
			calls++;
			return Promise.reject(new Error("unexpected end of stream"));
		};
		const handle = installFetchShim(HOSTS, transport, { ...NO_WAIT, attempts: 2 });
		restore = handle.restore;

		await expect(fetch(`${HOSTS[0]}/sync/v4/root`)).rejects.toThrow(/unexpected end of stream/);
		expect(calls).toBe(2);
	});

	it("does not retry non-transient failures", async () => {
		let calls = 0;
		const transport: ShimTransport = () => {
			calls++;
			return Promise.reject(new Error("Pairing code was rejected"));
		};
		const handle = installFetchShim(HOSTS, transport, NO_WAIT);
		restore = handle.restore;

		await expect(fetch(`${HOSTS[0]}/x`)).rejects.toThrow(/rejected/);
		expect(calls).toBe(1);
	});

	it("leaves requests to other hosts on the original fetch", async () => {
		let shimCalls = 0;
		const original = globalThis.fetch;
		const handle = installFetchShim(
			HOSTS,
			() => {
				shimCalls++;
				return Promise.resolve(okResponse());
			},
			NO_WAIT,
		);
		restore = handle.restore;

		expect(globalThis.fetch).not.toBe(original);
		await globalThis.fetch("https://example.invalid/nothing").catch(() => undefined); // network is unavailable in tests; only routing matters
		expect(shimCalls).toBe(0);
	});

	it("restores the original fetch", () => {
		const original = globalThis.fetch;
		const handle = installFetchShim(HOSTS, () => Promise.resolve(okResponse()), NO_WAIT);
		handle.restore();
		expect(globalThis.fetch).toBe(original);
	});
});

describe("installFetchShim concurrency gate (GP_E5_S9)", () => {
	it("caps in-flight transport requests and still completes them all", async () => {
		let inFlight = 0;
		let maxSeen = 0;
		const finishers: (() => void)[] = [];
		const transport: ShimTransport = () => {
			inFlight++;
			maxSeen = Math.max(maxSeen, inFlight);
			return new Promise((resolve) => {
				finishers.push(() => {
					inFlight--;
					resolve(okResponse());
				});
			});
		};
		const handle = installFetchShim(HOSTS, transport, { ...NO_WAIT, maxConcurrent: 3 });
		restore = handle.restore;

		// The flood rmapi-js produces: far more requests than the cap, at once.
		const calls = Array.from({ length: 10 }, (_, i) => fetch(`${HOSTS[0]}/entry/${i}`));
		// Drain: finish whatever is admitted until every request went through.
		let finished = 0;
		while (finished < 10) {
			await Promise.resolve();
			const batch = finishers.splice(0);
			expect(batch.length).toBeLessThanOrEqual(3);
			for (const finish of batch) {
				finish();
				finished++;
			}
		}
		const responses = await Promise.all(calls);
		expect(responses.map((r) => r.status)).toEqual(Array.from({ length: 10 }, () => 200));
		expect(maxSeen).toBe(3);
	});

	it("holds a slot across retries instead of letting the queue overtake", async () => {
		const order: string[] = [];
		let firstAttempts = 0;
		const transport: ShimTransport = (request) => {
			order.push(request.url.split("/").pop() ?? "");
			if (request.url.endsWith("/first")) {
				firstAttempts++;
				if (firstAttempts < 3) {
					return Promise.reject(new Error("net::ERR_INSUFFICIENT_RESOURCES"));
				}
			}
			return Promise.resolve(okResponse());
		};
		const handle = installFetchShim(HOSTS, transport, { ...NO_WAIT, maxConcurrent: 1 });
		restore = handle.restore;

		const first = fetch(`${HOSTS[0]}/first`);
		const second = fetch(`${HOSTS[0]}/second`);
		await Promise.all([first, second]);
		// The flood error was retried to success, and the retries kept their
		// slot: the queued request was only admitted after the first finished.
		expect(order).toEqual(["first", "first", "first", "second"]);
	});

	it("clamps a nonsensical cap to 1 instead of deadlocking", async () => {
		let calls = 0;
		const transport: ShimTransport = () => {
			calls++;
			return Promise.resolve(okResponse());
		};
		const handle = installFetchShim(HOSTS, transport, { ...NO_WAIT, maxConcurrent: 0 });
		restore = handle.restore;

		const responses = await Promise.all([fetch(`${HOSTS[0]}/a`), fetch(`${HOSTS[0]}/b`)]);
		expect(responses.map((r) => r.status)).toEqual([200, 200]);
		expect(calls).toBe(2);
	});

	it("rejects queued requests on restore instead of firing them after unload", async () => {
		let started = 0;
		let finishFirst: (() => void) | undefined;
		const transport: ShimTransport = () => {
			started++;
			return new Promise((resolve) => {
				finishFirst = () => resolve(okResponse());
			});
		};
		const handle = installFetchShim(HOSTS, transport, { ...NO_WAIT, maxConcurrent: 1 });

		const first = fetch(`${HOSTS[0]}/holds-the-slot`);
		const queued = fetch(`${HOSTS[0]}/never-admitted`);
		await flush();
		handle.restore();

		await expect(queued).rejects.toThrow(/shut down or reconfigured/);
		expect(started).toBe(1);
		// The request already holding its slot still completes normally.
		finishFirst?.();
		expect((await first).status).toBe(200);
	});

	it("abandons a hung request after the timeout so its slot frees up (deadlock valve)", async () => {
		const timers: (() => void)[] = [];
		let started = 0;
		const transport: ShimTransport = (request) => {
			started++;
			return request.url.endsWith("/hangs")
				? new Promise(() => undefined)
				: Promise.resolve(okResponse());
		};
		const handle = installFetchShim(HOSTS, transport, {
			...NO_WAIT,
			maxConcurrent: 1,
			requestTimeoutMs: 1000,
			setTimer: (fn) => timers.push(fn) - 1,
			clearTimer: (id) => {
				timers[id] = () => undefined;
			},
		});
		restore = handle.restore;

		const hung = fetch(`${HOSTS[0]}/hangs`);
		const queued = fetch(`${HOSTS[0]}/after`);
		await flush();
		expect(started).toBe(1);

		timers.splice(0).forEach((fire) => fire());
		await expect(hung).rejects.toThrow(/did not complete within 1s/);
		// The freed slot admits the queued request, which completes normally.
		expect((await queued).status).toBe(200);
		expect(started).toBe(2);
	});
});
