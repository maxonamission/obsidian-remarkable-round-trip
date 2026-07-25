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

export interface ShimOptions {
	/** Attempts per request when the transport fails at connection level. */
	attempts?: number;
	/** Delay before retry N (ms); injected so tests run instantly. */
	backoffMs?: (attempt: number) => number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Connection-level failures worth retrying: the request never produced a
 * response, so nothing was observed by us. Android's okhttp stack raises
 * "unexpected end of stream" when it reuses a pooled connection the server
 * has already closed — the failure mode a beta tester hit on mobile
 * (GP_E2_S12). HTTP error *statuses* are not retried here; callers map those
 * to actionable messages themselves.
 */
export function isTransientTransportError(error: unknown): boolean {
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
	return (
		message.includes("unexpected end of stream") ||
		message.includes("request failed") ||
		message.includes("econnreset") ||
		message.includes("epipe") ||
		message.includes("etimedout") ||
		message.includes("socket") ||
		message.includes("network")
	);
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
export function installFetchShim(
	hosts: string[],
	transport: ShimTransport,
	options: ShimOptions = {},
): ShimHandle {
	const scope = globalThis as { fetch: typeof fetch };
	// Keep the exact original reference (call it with an explicit receiver)
	// so restore() is a true undo: binding here would stack a new wrapper on
	// every settings save, since saveSettings reinstalls the shim.
	const originalFetch = scope.fetch;
	const callOriginal: typeof fetch = (input, init) =>
		originalFetch.call(globalThis, input, init);
	const attempts = options.attempts ?? 3;
	const backoffMs = options.backoffMs ?? ((attempt: number) => 250 * 2 ** (attempt - 1));
	const sleep =
		options.sleep ?? ((ms: number) => new Promise<void>((r) => window.setTimeout(r, ms)));

	/**
	 * Every request rmapi-js makes is safe to repeat: reads are GETs, blob
	 * writes are content-addressed, and the root update is generation-guarded
	 * (a duplicate loses the race instead of corrupting state).
	 */
	const sendWithRetry = async (
		request: Parameters<ShimTransport>[0],
	): Promise<ShimTransportResponse> => {
		let lastError: unknown;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				return await transport(request);
			} catch (error) {
				lastError = error;
				if (attempt === attempts || !isTransientTransportError(error)) throw error;
				await sleep(backoffMs(attempt));
			}
		}
		throw lastError;
	};

	const shimmed = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (!matchesHost(url, hosts)) return callOriginal(input, init);

		const request = input instanceof Request ? input : null;
		const method = init?.method ?? request?.method ?? "GET";
		const headers = headersToRecord(init?.headers ?? request?.headers);
		const rawBody = init?.body ?? (request ? await request.arrayBuffer() : undefined);
		const body = await bodyToTransportBody(rawBody);

		const response = await sendWithRetry({ url, method, headers, body });
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
