/**
 * reMarkable cloud client (PRD F4, F7, K4, N3).
 *
 * Implements the device-token flow and document upload against the official
 * cloud endpoints, with every host configurable so a self-hosted rmfakecloud
 * can take over unchanged (F7). The API is not officially documented and has
 * changed before (rmapi breakage, PRD §7): all calls go through the injected
 * HttpClient, errors surface as actionable TransportError messages, and no
 * response shape is trusted blindly.
 *
 * MVP scope note: uploads land in the device root via the simple upload
 * endpoint (`/doc/v2/files`, the "Read on reMarkable" flow). Mirroring the
 * vault folder structure needs the sync API and is a separate story.
 */

import { HttpClient, TransportError } from "./http";

export interface CloudEndpoints {
	/** Token host (registration + user token). */
	authHost: string;
	/** Document host (upload). */
	docHost: string;
}

export const OFFICIAL_ENDPOINTS: CloudEndpoints = {
	authHost: "https://webapp-prod.cloud.remarkable.engineering",
	docHost: "https://internal.cloud.remarkable.com",
};

/** rmfakecloud serves auth and docs from one base URL (F7). */
export function rmfakecloudEndpoints(baseUrl: string): CloudEndpoints {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return { authHost: trimmed, docHost: trimmed };
}

export interface DeviceRegistration {
	deviceToken: string;
	deviceId: string;
}

export interface UploadResult {
	/** Document UUID assigned by the cloud. */
	deviceDocId: string;
	/** Content hash, when the endpoint reports one. */
	hash?: string;
}

interface CloudClientDeps {
	http: HttpClient;
	endpoints?: CloudEndpoints;
	/** Persisted device token (empty when not yet registered). */
	deviceToken?: string;
	generateDeviceId?: () => string;
}

export class RemarkableCloudClient {
	private readonly http: HttpClient;
	private readonly endpoints: CloudEndpoints;
	private deviceToken: string;
	private userToken: string | null = null;
	private readonly generateDeviceId: () => string;

	constructor(deps: CloudClientDeps) {
		this.http = deps.http;
		this.endpoints = deps.endpoints ?? OFFICIAL_ENDPOINTS;
		this.deviceToken = deps.deviceToken ?? "";
		this.generateDeviceId = deps.generateDeviceId ?? (() => crypto.randomUUID());
	}

	get isRegistered(): boolean {
		return this.deviceToken !== "";
	}

	/**
	 * Exchange a one-time pairing code (my.remarkable.com → "pair a browser")
	 * for a long-lived device token. The caller persists the returned token.
	 */
	async register(oneTimeCode: string): Promise<DeviceRegistration> {
		const code = oneTimeCode.trim().toLowerCase();
		if (!/^[a-z]{8}$/.test(code)) {
			throw new TransportError(
				"Pairing code must be the 8-letter code from my.remarkable.com/device/browser/connect.",
			);
		}
		const deviceId = this.generateDeviceId();
		const response = await this.http({
			url: `${this.endpoints.authHost}/token/json/2/device/new`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				code,
				deviceDesc: "browser-chrome",
				deviceID: deviceId,
			}),
		});
		if (response.status !== 200 || response.text.trim() === "") {
			throw new TransportError(
				response.status === 400 || response.status === 401
					? "Pairing code was rejected — codes expire quickly, generate a fresh one and try again."
					: `Device registration failed (HTTP ${response.status}).`,
				response.status,
			);
		}
		this.deviceToken = response.text.trim();
		this.userToken = null;
		return { deviceToken: this.deviceToken, deviceId };
	}

	/** Refresh the short-lived user token from the device token. */
	private async ensureUserToken(): Promise<string> {
		if (this.userToken !== null) return this.userToken;
		if (!this.isRegistered) {
			throw new TransportError(
				"Not connected to a reMarkable account yet — pair the plugin in the settings first.",
			);
		}
		const response = await this.http({
			url: `${this.endpoints.authHost}/token/json/2/user/new`,
			method: "POST",
			headers: { Authorization: `Bearer ${this.deviceToken}` },
		});
		if (response.status !== 200 || response.text.trim() === "") {
			throw new TransportError(
				response.status === 401
					? "The stored device token is no longer valid — re-pair the plugin in the settings."
					: `Could not refresh the session token (HTTP ${response.status}).`,
				response.status,
			);
		}
		this.userToken = response.text.trim();
		return this.userToken;
	}

	/**
	 * Upload a PDF via the simple endpoint. Returns the cloud-assigned
	 * document ID, which the mapping store links to the note's stable docId
	 * (F5). An optional parent collection ID is honored when given (the
	 * endpoint itself cannot create folders — see MirrorTransport for that).
	 */
	async uploadPdf(
		fileName: string,
		pdfBytes: Uint8Array,
		parentId?: string,
	): Promise<UploadResult> {
		const userToken = await this.ensureUserToken();
		const meta: { file_name: string; parent?: string } = { file_name: fileName };
		if (parentId !== undefined && parentId !== "") meta.parent = parentId;
		const body = pdfBytes.buffer.slice(
			pdfBytes.byteOffset,
			pdfBytes.byteOffset + pdfBytes.byteLength,
		) as ArrayBuffer;
		const attempt = () =>
			this.http({
				url: `${this.endpoints.docHost}/doc/v2/files`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${userToken}`,
					"Content-Type": "application/pdf",
					"rm-meta": toBase64(JSON.stringify(meta)),
					"rm-source": "RoR-Browser",
				},
				body,
			});

		let response = await attempt();
		if (response.status === 401) {
			// User token expired mid-session: refresh once and retry.
			this.userToken = null;
			await this.ensureUserToken();
			response = await attempt();
		}
		if (response.status < 200 || response.status >= 300) {
			throw new TransportError(uploadErrorMessage(response.status), response.status);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(response.text);
		} catch {
			throw new TransportError(
				"Upload succeeded but the cloud returned an unexpected response — " +
					"check the device; the API may have changed.",
			);
		}
		const docId = (parsed as { docID?: string; docId?: string }).docID ??
			(parsed as { docId?: string }).docId;
		if (typeof docId !== "string" || docId === "") {
			throw new TransportError(
				"Upload response did not contain a document ID — the API may have changed.",
			);
		}
		return { deviceDocId: docId, hash: (parsed as { hash?: string }).hash };
	}
}

function uploadErrorMessage(status: number): string {
	switch (status) {
		case 401:
			return "The reMarkable session was rejected — re-pair the plugin in the settings.";
		case 403:
			return "The reMarkable cloud refused the upload (forbidden).";
		case 413:
			return "The PDF is too large for the reMarkable cloud.";
		default:
			return `Upload failed (HTTP ${status}) — the note was not changed; try again later.`;
	}
}

/** UTF-8 safe base64 without Node's Buffer (N7: mobile has no Node APIs). */
export function toBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
