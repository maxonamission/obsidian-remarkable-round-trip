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
	/**
	 * The window whose `fetch` is patched. Obsidian runs plugins per window
	 * and a popped-out window has its own, so the caller says which one —
	 * patching the shared global would reach windows this plugin was never
	 * loaded into. Defaults to the window this module was loaded in.
	 */
	scope?: { fetch: typeof fetch };
	/**
	 * Max transport requests in flight at once; the rest wait their turn
	 * (GP_E5_S9). rmapi-js lists the device tree with an unbounded
	 * Promise.all — three requests per item, all at once — which desktop
	 * Electron rejects wholesale with net::ERR_INSUFFICIENT_RESOURCES once
	 * the tree is a few hundred items. Mobile's native HTTP stacks queue
	 * instead, which is exactly what this gate gives every platform.
	 * Clamped to at least 1.
	 */
	maxConcurrent?: number;
	/**
	 * Ceiling (ms) before a gated request is failed to free its slot. A
	 * deadlock valve, not a tuning knob: without it one transport call that
	 * never settles (requestUrl has no timeout of its own) would hold its
	 * slot forever, and eight of those would silently starve all reMarkable
	 * traffic until restart. Generous by default — a slow multi-MB upload
	 * must comfortably fit.
	 */
	requestTimeoutMs?: number;
	/** Timer injection so tests can fire the timeout valve deterministically. */
	setTimer?: (fn: () => void, ms: number) => number;
	clearTimer?: (id: number) => void;
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
		message.includes("network") ||
		// Chromium/Electron's "too many requests in flight" — the request never
		// left, so a retry (behind the concurrency gate) is safe (GP_E5_S9).
		message.includes("insufficient_resources")
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
	const scope = options.scope ?? window;
	// Keep the exact original reference (call it with an explicit receiver)
	// so restore() is a true undo: binding here would stack a new wrapper on
	// every settings save, since saveSettings reinstalls the shim.
	const originalFetch = scope.fetch;
	const callOriginal: typeof fetch = (input, init) => originalFetch.call(scope, input, init);
	const attempts = options.attempts ?? 3;
	const backoffMs = options.backoffMs ?? ((attempt: number) => 250 * 2 ** (attempt - 1));
	const sleep =
		options.sleep ?? ((ms: number) => new Promise<void>((r) => window.setTimeout(r, ms)));
	const maxConcurrent = Math.max(1, options.maxConcurrent ?? 8);
	const requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
	const setTimer =
		options.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms));
	const clearTimer = options.clearTimer ?? ((id: number) => window.clearTimeout(id));

	// Minimal FIFO gate; a slot is held across a request's retries so a
	// struggling request cannot be overtaken by an ever-growing queue.
	let inFlight = 0;
	const waiting: { grant: () => void; reject: (error: Error) => void }[] = [];
	const acquire = (): Promise<void> =>
		new Promise((resolve, reject) => {
			if (inFlight < maxConcurrent) {
				inFlight++;
				resolve();
			} else {
				waiting.push({
					grant: () => {
						inFlight++;
						resolve();
					},
					reject,
				});
			}
		});
	const release = (): void => {
		inFlight--;
		waiting.shift()?.grant();
	};

	// The valve behind requestTimeoutMs: the abandoned transport call may
	// still settle later, but its slot is freed and its caller gets an error
	// instead of an eternal await.
	const withTimeout = <T>(work: Promise<T>): Promise<T> =>
		new Promise((resolve, reject) => {
			const timer = setTimer(() => {
				reject(
					new Error(
						`reMarkable request did not complete within ${Math.round(requestTimeoutMs / 1000)}s and was abandoned.`,
					),
				);
			}, requestTimeoutMs);
			work.then(
				(value) => {
					clearTimer(timer);
					resolve(value);
				},
				(error: unknown) => {
					clearTimer(timer);
					reject(error instanceof Error ? error : new Error(String(error)));
				},
			);
		});

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

	const shimmed = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (!matchesHost(url, hosts)) return callOriginal(input, init);

		const request = input instanceof Request ? input : null;
		const method = init?.method ?? request?.method ?? "GET";
		const headers = headersToRecord(init?.headers ?? request?.headers);
		const rawBody = init?.body ?? (request ? await request.arrayBuffer() : undefined);
		const body = await bodyToTransportBody(rawBody);

		await acquire();
		let response: ShimTransportResponse;
		try {
			response = await withTimeout(sendWithRetry({ url, method, headers, body }));
		} finally {
			release();
		}
		return new Response(response.status === 204 ? null : response.arrayBuffer, {
			status: response.status,
			headers: response.headers,
		});
	};

	scope.fetch = shimmed;
	return {
		restore: () => {
			scope.fetch = originalFetch;
			// Requests that never got a slot must not fire minutes after the
			// plugin unloaded or the transport was reconfigured — fail them
			// now, loudly, instead of letting them outlive their shim.
			for (const waiter of waiting.splice(0)) {
				waiter.reject(
					new Error(
						"reMarkable transport was shut down or reconfigured before this request started; send again.",
					),
				);
			}
		},
	};
}
