import { describe, expect, it } from "vitest";
import { adviseFailure, classifyFailure } from "../transport/failure";

describe("classifyFailure", () => {
	it("recognises the Android name-resolution failure from the beta", () => {
		// Verbatim from the device (2026-07-26).
		const message =
			"Request Failed. UnknownHostException Unable to resolve host " +
			'"eu.tectonic.remarkable.com": No address associated with hostname';
		expect(classifyFailure(new Error(message))).toBe("offline");
	});

	it("recognises the desktop and browser variants", () => {
		expect(classifyFailure(new Error("getaddrinfo ENOTFOUND api.remarkable.com"))).toBe(
			"offline",
		);
		expect(classifyFailure(new Error("TypeError: Failed to fetch"))).toBe("offline");
		expect(classifyFailure(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe("offline");
	});

	it("keeps credentials and server errors apart from being offline", () => {
		expect(classifyFailure(new Error("401 Unauthorized"))).toBe("auth");
		expect(classifyFailure(new Error("503 Service Unavailable"))).toBe("server");
		expect(classifyFailure(new Error("something else entirely"))).toBe("unknown");
	});

	it("does not blame pairing for a network failure", () => {
		const advice = adviseFailure("offline");
		expect(advice).toContain("network problem, not your pairing");
		expect(advice).toContain("DNS");
	});

	it("says nothing when it cannot tell, rather than guessing", () => {
		expect(adviseFailure("unknown")).toBe("");
	});
});
