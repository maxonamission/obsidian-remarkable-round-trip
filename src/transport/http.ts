/**
 * Minimal HTTP abstraction (PRD N3, N7).
 *
 * The plugin edge implements this with Obsidian's `requestUrl` (mobile-safe,
 * CORS-free); tests inject a fake. Keeping transport behind this seam is the
 * abstraction layer PRD §7 asks for against reMarkable API changes.
 */

export interface HttpRequest {
	url: string;
	method: "GET" | "POST" | "PUT" | "DELETE";
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	/** Never throw on non-2xx: callers translate status codes to clear errors. */
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
	arrayBuffer?: ArrayBuffer;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/** Error with a user-facing, actionable message (N3: degrade cleanly). */
export class TransportError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "TransportError";
	}
}
