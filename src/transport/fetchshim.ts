/**
 * Host-aware fetch shim (GP_E2_S7, N7).
 *
 * rmapi-js calls the global `fetch`, which is CORS-bound inside Obsidian.
 * This shim routes requests to the configured reMarkable hosts through the
 * CORS-free transport (Obsidian's `requestUrl` at the plugin edge) and passes
 * every other request through untouched — so nothing else in the app is
 * affected. Installed at plugin load, restored at unload.
 */

export interface ShimTransportResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
}

export type ShimTransport = (request: {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string | ArrayBuffer;
}) => Promise<ShimTransportResponse>;

interface ShimHandle {
	restore: () => void;
}

function matchesHost(url: string, hosts: string[]): boolean {
	return hosts.some((host) => host !== "" && url.startsWith(host));
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
	const record: Record<string, string> = {};
	if (!headers) return record;
	if (headers instanceof Headers) {
		headers.forEach((value, key) => {
			record[key] = value;
		});
	} else if (Array.isArray(headers)) {
		for (const [key, value] of headers) record[key] = value;
	} else {
		Object.assign(record, headers);
	}
	return record;
}

async function bodyToTransportBody(
	body: BodyInit | null | undefined,
): Promise<string | ArrayBuffer | undefined> {
	if (body === null || body === undefined) return undefined;
	if (typeof body === "string") return body;
	if (body instanceof ArrayBuffer) return body;
	if (ArrayBuffer.isView(body)) {
		return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
	}
	if (body instanceof Blob) return body.arrayBuffer();
	throw new Error("Unsupported request body type for reMarkable transport shim.");
}

/**
 * Replace the global fetch with a version that routes the given hosts through
 * `transport`. Returns a handle whose `restore()` puts the original back.
 */
export function installFetchShim(hosts: string[], transport: ShimTransport): ShimHandle {
	const scope = globalThis as { fetch: typeof fetch };
	const originalFetch = scope.fetch.bind(globalThis);

	const shimmed = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (!matchesHost(url, hosts)) return originalFetch(input, init);

		const request = input instanceof Request ? input : null;
		const method = init?.method ?? request?.method ?? "GET";
		const headers = headersToRecord(init?.headers ?? request?.headers);
		const rawBody = init?.body ?? (request ? await request.arrayBuffer() : undefined);
		const body = await bodyToTransportBody(rawBody);

		const response = await transport({ url, method, headers, body });
		return new Response(response.status === 204 ? null : response.arrayBuffer, {
			status: response.status,
			headers: response.headers,
		});
	};

	scope.fetch = shimmed;
	return {
		restore: () => {
			scope.fetch = originalFetch;
		},
	};
}
