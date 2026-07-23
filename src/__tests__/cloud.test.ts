import { describe, expect, it } from "vitest";
import {
	OFFICIAL_ENDPOINTS,
	RemarkableCloudClient,
	rmfakecloudEndpoints,
	toBase64,
} from "../transport/cloud";
import { HttpRequest, HttpResponse, TransportError } from "../transport/http";

function fakeHttp(handler: (req: HttpRequest) => Partial<HttpResponse>) {
	const calls: HttpRequest[] = [];
	const http = (req: HttpRequest): Promise<HttpResponse> => {
		calls.push(req);
		const partial = handler(req);
		return Promise.resolve({ status: 200, headers: {}, text: "", ...partial });
	};
	return { http, calls };
}

describe("register", () => {
	it("exchanges a pairing code for a device token", async () => {
		const { http, calls } = fakeHttp(() => ({ text: "device-token-jwt" }));
		const client = new RemarkableCloudClient({ http, generateDeviceId: () => "fixed-id" });
		const result = await client.register("ABCDEFGH");

		expect(result.deviceToken).toBe("device-token-jwt");
		expect(calls[0].url).toBe(`${OFFICIAL_ENDPOINTS.authHost}/token/json/2/device/new`);
		const body = JSON.parse(calls[0].body as string) as Record<string, string>;
		expect(body).toEqual({ code: "abcdefgh", deviceDesc: "browser-chrome", deviceID: "fixed-id" });
		expect(client.isRegistered).toBe(true);
	});

	it("rejects malformed pairing codes before calling the network", async () => {
		const { http, calls } = fakeHttp(() => ({}));
		const client = new RemarkableCloudClient({ http });
		await expect(client.register("kort")).rejects.toThrow(TransportError);
		expect(calls).toHaveLength(0);
	});

	it("translates a rejected code into an actionable message", async () => {
		const { http } = fakeHttp(() => ({ status: 401 }));
		const client = new RemarkableCloudClient({ http });
		await expect(client.register("abcdefgh")).rejects.toThrow(/expire quickly/);
	});
});

describe("uploadPdf", () => {
	const pdfBytes = new Uint8Array([1, 2, 3]);

	it("refuses to upload when not paired", async () => {
		const { http } = fakeHttp(() => ({}));
		const client = new RemarkableCloudClient({ http });
		await expect(client.uploadPdf("n.pdf", pdfBytes)).rejects.toThrow(/Not connected/);
	});

	it("refreshes the user token and posts the PDF with rm-meta", async () => {
		const { http, calls } = fakeHttp((req) => {
			if (req.url.includes("/token/json/2/user/new")) return { text: "user-token" };
			return { text: JSON.stringify({ docID: "cloud-doc-1", hash: "h1" }) };
		});
		const client = new RemarkableCloudClient({ http, deviceToken: "device-token" });
		const result = await client.uploadPdf("Nota.pdf", pdfBytes);

		expect(result).toEqual({ deviceDocId: "cloud-doc-1", hash: "h1" });
		expect(calls[0].headers?.Authorization).toBe("Bearer device-token");
		const upload = calls[1];
		expect(upload.url).toBe(`${OFFICIAL_ENDPOINTS.docHost}/doc/v2/files`);
		expect(upload.headers?.Authorization).toBe("Bearer user-token");
		expect(upload.headers?.["Content-Type"]).toBe("application/pdf");
		expect(JSON.parse(atob(upload.headers?.["rm-meta"] ?? ""))).toEqual({
			file_name: "Nota.pdf",
		});
		expect(new Uint8Array(upload.body as ArrayBuffer)).toEqual(pdfBytes);
	});

	it("retries once with a fresh user token on 401", async () => {
		let uploads = 0;
		const { http, calls } = fakeHttp((req) => {
			if (req.url.includes("/user/new")) return { text: `user-token-${calls.length}` };
			uploads++;
			return uploads === 1
				? { status: 401 }
				: { text: JSON.stringify({ docID: "cloud-doc-2" }) };
		});
		const client = new RemarkableCloudClient({ http, deviceToken: "device-token" });
		const result = await client.uploadPdf("n.pdf", pdfBytes);
		expect(result.deviceDocId).toBe("cloud-doc-2");
		expect(uploads).toBe(2);
	});

	it("surfaces an API-change signal on unexpected response bodies", async () => {
		const { http } = fakeHttp((req) =>
			req.url.includes("/user/new") ? { text: "user-token" } : { text: "<html>" },
		);
		const client = new RemarkableCloudClient({ http, deviceToken: "device-token" });
		await expect(client.uploadPdf("n.pdf", pdfBytes)).rejects.toThrow(/API may have changed/);
	});
});

describe("rmfakecloud endpoints", () => {
	it("routes auth and docs to one self-hosted base URL", async () => {
		const endpoints = rmfakecloudEndpoints("https://rm.example.org/");
		expect(endpoints).toEqual({
			authHost: "https://rm.example.org",
			docHost: "https://rm.example.org",
		});
		const { http, calls } = fakeHttp((req) =>
			req.url.includes("/user/new")
				? { text: "user-token" }
				: { text: JSON.stringify({ docID: "d" }) },
		);
		const client = new RemarkableCloudClient({ http, endpoints, deviceToken: "t" });
		await client.uploadPdf("n.pdf", new Uint8Array([1]));
		expect(calls.every((c) => c.url.startsWith("https://rm.example.org/"))).toBe(true);
	});
});

describe("toBase64", () => {
	it("handles non-ASCII file names", () => {
		const encoded = toBase64(JSON.stringify({ file_name: "Café Ideeën.pdf" }));
		const decoded = new TextDecoder().decode(
			Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
		);
		expect((JSON.parse(decoded) as { file_name: string }).file_name).toBe("Café Ideeën.pdf");
	});
});
