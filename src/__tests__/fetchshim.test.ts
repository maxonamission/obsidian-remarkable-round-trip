import { afterEach, describe, expect, it } from "vitest";
import {
	installFetchShim,
	isTransientTransportError,
	ShimTransport,
} from "../transport/fetchshim";

const HOSTS = ["https://eu.tectonic.remarkable.com"];
const NO_WAIT = { backoffMs: () => 0, sleep: () => Promise.resolve() };

let restore: (() => void) | null = null;
afterEach(() => {
	restore?.();
	restore = null;
});

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
