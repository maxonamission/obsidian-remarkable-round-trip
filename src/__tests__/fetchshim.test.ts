import { afterEach, describe, expect, it } from "vitest";
import {
	installFetchShim,
	isTransientTransportError,
	retryAfterMs,
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
		expect(
			isTransientTransportError(new Error("Pairing code was rejected")),
		).toBe(false);
	});
});

describe("retryAfterMs", () => {
	it("reads delay-seconds, case-insensitively", () => {
		expect(retryAfterMs({ "retry-after": "7" })).toBe(7_000);
		expect(retryAfterMs({ "Retry-After": " 0 " })).toBe(0);
	});

	it("reads an HTTP-date relative to now", () => {
		const now = Date.parse("2026-09-09T12:00:00Z");
		expect(
			retryAfterMs(
				{ "Retry-After": "Wed, 09 Sep 2026 12:00:30 GMT" },
				() => now,
			),
		).toBe(30_000);
		// A date in the past means "now", never a negative wait.
		expect(
			retryAfterMs(
				{ "Retry-After": "Wed, 09 Sep 2026 11:00:00 GMT" },
				() => now,
			),
		).toBe(0);
	});

	it("is undefined for a number too large to be a wait (GP_E5_S21)", () => {
		expect(retryAfterMs({ "Retry-After": "9".repeat(400) })).toBeUndefined();
	});

	it("is undefined when absent or unparseable, so the schedule applies", () => {
		expect(retryAfterMs({})).toBeUndefined();
		expect(retryAfterMs({ "Retry-After": "soon" })).toBeUndefined();
	});
});

describe("installFetchShim retries", () => {
	it("shares a cooldown and retries HTTP 429 responses", async () => {
		let calls = 0;
		const waits: number[] = [];
		const transport: ShimTransport = () => {
			calls++;
			return Promise.resolve(
				calls === 1
					? { ...okResponse(), status: 429 }
					: okResponse("after-cooldown"),
			);
		};
		const handle = installFetchShim(HOSTS, transport, {
			...NO_WAIT,
			rateLimitBackoffMs: () => 5_000,
			sleep: (ms) => {
				waits.push(ms);
				return Promise.resolve();
			},
		});
		restore = handle.restore;

		const response = await fetch(`${HOSTS[0]}/sync/v4/root`);
		expect(await response.text()).toBe("after-cooldown");
		expect(calls).toBe(2);
		expect(waits).toEqual([5_000]);
	});

	it("honours Retry-After on a 429 over the fallback schedule", async () => {
		let calls = 0;
		const waits: number[] = [];
		const transport: ShimTransport = () => {
			calls++;
			return Promise.resolve(
				calls === 1
					? { ...okResponse(), status: 429, headers: { "Retry-After": "12" } }
					: okResponse("after-retry-after"),
			);
		};
		const handle = installFetchShim(HOSTS, transport, {
			...NO_WAIT,
			rateLimitBackoffMs: () => 5_000,
			sleep: (ms) => {
				waits.push(ms);
				return Promise.resolve();
			},
		});
		restore = handle.restore;

		const response = await fetch(`${HOSTS[0]}/sync/v4/root`);
		expect(await response.text()).toBe("after-retry-after");
		expect(waits).toEqual([12_000]);
	});

	// GP_E5_S21: the header is advice from a machine we do not control.
	function rateLimitedOnce(header: string | undefined, waits: number[]) {
		let calls = 0;
		const headers: Record<string, string> =
			header === undefined ? {} : { "Retry-After": header };
		const transport: ShimTransport = () => {
			calls++;
			return Promise.resolve(
				calls === 1 ? { ...okResponse(), status: 429, headers } : okResponse("recovered"),
			);
		};
		const handle = installFetchShim(HOSTS, transport, {
			...NO_WAIT,
			rateLimitBackoffMs: () => 5_000,
			sleep: (ms) => {
				waits.push(ms);
				return Promise.resolve();
			},
		});
		restore = handle.restore;
	}

	it("caps an absurd Retry-After at the ceiling instead of freezing for an hour", async () => {
		const waits: number[] = [];
		rateLimitedOnce("3600", waits);
		const response = await fetch(`${HOSTS[0]}/sync/v4/root`);
		expect(await response.text()).toBe("recovered");
		expect(waits).toEqual([120_000]);
	});

	it("lifts a zero Retry-After to the floor so a 429 never retries at once", async () => {
		const waits: number[] = [];
		rateLimitedOnce("0", waits);
		await fetch(`${HOSTS[0]}/sync/v4/root`);
		expect(waits).toEqual([1_000]);
	});

	it("falls back to the schedule when Retry-After is nonsense", async () => {
		const waits: number[] = [];
		rateLimitedOnce("soon", waits);
		await fetch(`${HOSTS[0]}/sync/v4/root`);
		expect(waits).toEqual([5_000]);
	});

	it("takes the longest cooldown when requests trip 429 together, not the sum", async () => {
		const attempts: Record<string, number> = {};
		const waits: number[] = [];
		const transport: ShimTransport = (request) => {
			const name = request.url.split("/").pop() ?? "";
			attempts[name] = (attempts[name] ?? 0) + 1;
			if (attempts[name] === 1) {
				return Promise.resolve({
					...okResponse(),
					status: 429,
					headers: { "Retry-After": name === "long" ? "12" : "5" },
				});
			}
			return Promise.resolve(okResponse(name));
		};
		const handle = installFetchShim(HOSTS, transport, {
			...NO_WAIT,
			now: () => 1_000_000,
			sleep: (ms) => {
				waits.push(ms);
				return Promise.resolve();
			},
		});
		restore = handle.restore;

		const responses = await Promise.all([
			fetch(`${HOSTS[0]}/long`),
			fetch(`${HOSTS[0]}/short`),
		]);
		expect(await Promise.all(responses.map((r) => r.text()))).toEqual(["long", "short"]);
		// One 12 s cooldown covers both; the 5 s ask falls inside it and adds nothing.
		expect(waits).toEqual([12_000]);
		expect(attempts).toEqual({ long: 2, short: 2 });
	});

	it("holds newly admitted requests behind the shared 429 cooldown", async () => {
		const started: string[] = [];
		let firstAttempts = 0;
		let finishCooldown: (() => void) | undefined;
		const handle = installFetchShim(
			HOSTS,
			(request) => {
				started.push(request.url.split("/").pop() ?? "");
				if (request.url.endsWith("/first") && ++firstAttempts === 1) {
					return Promise.resolve({ ...okResponse(), status: 429 });
				}
				return Promise.resolve(okResponse());
			},
			{
				...NO_WAIT,
				sleep: () =>
					new Promise<void>((resolve) => {
						finishCooldown = resolve;
					}),
			},
		);
		restore = handle.restore;
		const first = fetch(`${HOSTS[0]}/first`);
		await flush();
		expect(finishCooldown).toBeDefined();
		const second = fetch(`${HOSTS[0]}/second`);
		await flush();
		expect(started).toEqual(["first"]);
		finishCooldown?.();
		const responses = await Promise.all([first, second]);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		expect(started.filter((name) => name === "first")).toHaveLength(2);
		expect(started.filter((name) => name === "second")).toHaveLength(1);
	});

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
		const handle = installFetchShim(HOSTS, transport, {
			...NO_WAIT,
			attempts: 2,
		});
		restore = handle.restore;

		await expect(fetch(`${HOSTS[0]}/sync/v4/root`)).rejects.toThrow(
			/unexpected end of stream/,
		);
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
		await globalThis
			.fetch("https://example.invalid/nothing")
			.catch(() => undefined); // network is unavailable in tests; only routing matters
		expect(shimCalls).toBe(0);
	});

	it("restores the original fetch", () => {
		const original = globalThis.fetch;
		const handle = installFetchShim(
			HOSTS,
			() => Promise.resolve(okResponse()),
			NO_WAIT,
		);
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
		const handle = installFetchShim(HOSTS, transport, {
			...NO_WAIT,
			maxConcurrent: 3,
		});
		restore = handle.restore;

		// The flood rmapi-js produces: far more requests than the cap, at once.
		const calls = Array.from({ length: 10 }, (_, i) =>
			fetch(`${HOSTS[0]}/entry/${i}`),
		);
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
		expect(responses.map((r) => r.status)).toEqual(
			Array.from({ length: 10 }, () => 200),
		);
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
		const handle = installFetchShim(HOSTS, transport, {
			...NO_WAIT,
			maxConcurrent: 1,
		});
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
		const handle = installFetchShim(HOSTS, transport, {
			...NO_WAIT,
			maxConcurrent: 0,
		});
		restore = handle.restore;

		const responses = await Promise.all([
			fetch(`${HOSTS[0]}/a`),
			fetch(`${HOSTS[0]}/b`),
		]);
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
		const handle = installFetchShim(HOSTS, transport, {
			...NO_WAIT,
			maxConcurrent: 1,
		});

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
