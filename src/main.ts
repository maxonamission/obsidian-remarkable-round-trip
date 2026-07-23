/**
 * reMarkable Round-Trip — Obsidian plugin edge (PRD F1, F4, F5).
 *
 * Everything Obsidian-specific lives here: commands, context menus, vault
 * access and the requestUrl-based HTTP adapter (mobile-safe, N7). The actual
 * pipeline (preprocess → PDF → upload → mapping) is pure and lives in src/.
 */

import {
	Menu,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	TFolder,
	requestUrl,
} from "obsidian";
import {
	DEFAULT_SETTINGS,
	RoundTripSettings,
	RoundTripSettingTab,
} from "./settings";
import { remarkable } from "rmapi-js";
import { HttpClient } from "./transport/http";
import {
	OFFICIAL_ENDPOINTS,
	RemarkableCloudClient,
	rmfakecloudEndpoints,
} from "./transport/cloud";
import { installFetchShim, ShimTransport } from "./transport/fetchshim";
import { MirrorTransport, toTransportError } from "./transport/mirror";
import { EmbedContent } from "./preprocess/preprocess";
import { DOCID_FRONTMATTER_KEY } from "./id/docid";
import { NoteInput, sendBatch, SendResult } from "./sync/send";
import { WatchQueue } from "./sync/watcher";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif"]);
const MAX_EMBED_DEPTH = 3;
const EMBED_SCAN_RE = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
// Quiet period before a watch-folder note is sent: long enough to survive a
// typing session, short enough to feel automatic (F6).
const WATCH_DEBOUNCE_MS = 15000;
// rmapi-js' default low-level host; part of the fetch-shim allowlist.
const RAW_HOST = "https://eu.tectonic.remarkable.com";

export default class RoundTripPlugin extends Plugin {
	settings: RoundTripSettings = { ...DEFAULT_SETTINGS };
	private watchQueue: WatchQueue | null = null;
	private fetchShim: { restore: () => void } | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new RoundTripSettingTab(this.app, this));
		this.setupWatcher();
		this.setupFetchShim();

		this.registerEvent(
			this.app.vault.on("modify", (file) => this.watchQueue?.noteChanged(file.path)),
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => this.watchQueue?.noteChanged(file.path)),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.watchQueue?.noteRemoved(oldPath);
				this.watchQueue?.noteChanged(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => this.watchQueue?.noteRemoved(file.path)),
		);

		this.addCommand({
			id: "send-current-note",
			name: "Send current note to reMarkable",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.sendFiles([file]);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "md") {
					menu.addItem((item) =>
						item
							.setTitle("Send to reMarkable")
							.setIcon("send")
							.onClick(() => void this.sendFiles([file])),
					);
				}
				if (file instanceof TFolder) {
					menu.addItem((item) =>
						item
							.setTitle("Send folder to reMarkable")
							.setIcon("send")
							.onClick(() => void this.sendFiles(collectMarkdownFiles(file))),
					);
				}
			}),
		);
	}

	async loadSettings(): Promise<void> {
		const stored = ((await this.loadData()) ?? {}) as Partial<RoundTripSettings>;
		this.settings = { ...DEFAULT_SETTINGS, ...stored };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.setupWatcher();
		this.setupFetchShim();
	}

	onunload(): void {
		this.watchQueue?.dispose();
		this.watchQueue = null;
		this.fetchShim?.restore();
		this.fetchShim = null;
	}

	/**
	 * rmapi-js uses the global fetch, which is CORS-bound in Obsidian; route
	 * only the reMarkable hosts through requestUrl (see fetchshim.ts, N7).
	 */
	private setupFetchShim(): void {
		this.fetchShim?.restore();
		const hosts = [OFFICIAL_ENDPOINTS.authHost, OFFICIAL_ENDPOINTS.docHost, RAW_HOST];
		if (this.settings.useCustomEndpoint && this.settings.customEndpointUrl !== "") {
			hosts.push(this.settings.customEndpointUrl.replace(/\/+$/, ""));
		}
		const transport: ShimTransport = async (request) => {
			const response = await requestUrl({
				url: request.url,
				method: request.method,
				headers: request.headers,
				body: request.body,
				throw: false,
			});
			return {
				status: response.status,
				headers: response.headers,
				arrayBuffer: response.arrayBuffer,
			};
		};
		this.fetchShim = installFetchShim(hosts, transport);
	}

	/** rmapi-js host options; rmfakecloud serves all three from one base (F7). */
	private rmapiOptions(): { authHost?: string; uploadHost?: string; rawHost?: string } {
		if (this.settings.useCustomEndpoint && this.settings.customEndpointUrl !== "") {
			const base = this.settings.customEndpointUrl.replace(/\/+$/, "");
			return { authHost: base, uploadHost: base, rawHost: base };
		}
		return {};
	}

	/** (Re)build the watch queue from the current settings (F6). */
	private setupWatcher(): void {
		this.watchQueue?.dispose();
		this.watchQueue = null;
		if (!this.settings.watchFolderEnabled || this.settings.watchFolderPath === "") {
			return;
		}
		this.watchQueue = new WatchQueue({
			folder: this.settings.watchFolderPath,
			debounceMs: WATCH_DEBOUNCE_MS,
			setTimer: (fn, ms) => window.setTimeout(fn, ms),
			clearTimer: (id) => window.clearTimeout(id),
			onReady: (path) => {
				const file = this.app.vault.getFileByPath(path);
				if (file) void this.sendFiles([file], { auto: true });
			},
		});
	}

	createClient(): RemarkableCloudClient {
		const endpoints =
			this.settings.useCustomEndpoint && this.settings.customEndpointUrl !== ""
				? rmfakecloudEndpoints(this.settings.customEndpointUrl)
				: OFFICIAL_ENDPOINTS;
		return new RemarkableCloudClient({
			http: obsidianHttp,
			endpoints,
			deviceToken: this.settings.deviceToken,
		});
	}

	/**
	 * Send notes. In `auto` mode (watch folder) unchanged notes are skipped
	 * and an all-skipped run stays silent — errors always surface.
	 */
	async sendFiles(files: TFile[], options: { auto?: boolean } = {}): Promise<void> {
		if (files.length === 0) {
			new Notice("No markdown notes to send.");
			return;
		}
		const client = this.createClient();
		if (!client.isRegistered) {
			new Notice("Not paired with a reMarkable account yet — open the plugin settings first.");
			return;
		}

		// Folder mirroring (GP_E2_S7): one rmapi-js session per send-run so the
		// folder listing is fetched once and reused across the batch.
		let mirror: MirrorTransport | null = null;
		if (this.settings.mirrorFolders) {
			try {
				const api = await remarkable(this.settings.deviceToken, this.rmapiOptions());
				mirror = new MirrorTransport(api, this.settings.deviceBaseFolder);
			} catch (error) {
				new Notice(toTransportError(error).message, 10000);
				return;
			}
		}

		const notice = new Notice(`Sending 0/${files.length} to reMarkable…`, 0);
		try {
			const notes: NoteInput[] = [];
			const embedMaps = new Map<string, Map<string, EmbedContent>>();
			for (const file of files) {
				notes.push({
					path: file.path,
					basename: file.basename,
					content: await this.app.vault.cachedRead(file),
					existingDocId: getFrontmatterValue(
						this.app.metadataCache.getFileCache(file)?.frontmatter,
						DOCID_FRONTMATTER_KEY,
					),
				});
				embedMaps.set(file.path, await this.buildEmbedMap(file));
			}

			const activeMirror = mirror;
			const { results, table } = await sendBatch(
				notes,
				this.settings.mappings,
				{
					client: activeMirror
						? {
								uploadPdf: (fileName, bytes, parentId) =>
									activeMirror
										.uploadPdf(fileName, bytes, parentId ?? "")
										.catch((error: unknown) => {
											throw toTransportError(error);
										}),
							}
						: client,
					resolveParent: activeMirror
						? (notePath) =>
								activeMirror
									.ensureFolderPath(notePath.split("/").slice(0, -1).join("/"))
									.catch((error: unknown) => {
										throw toTransportError(error);
									})
						: undefined,
					replacePrevious: activeMirror
						? (previousId) => activeMirror.trashPrevious(previousId)
						: undefined,
					resolveEmbed: (linkpath, notePath) =>
						embedMaps.get(notePath)?.get(linkpath) ?? { kind: "missing" },
					persistDocId: async (note, docId) => {
						const file = this.app.vault.getFileByPath(note.path);
						if (!file) return;
						await this.app.fileManager.processFrontMatter(file, (fm) => {
							(fm as Record<string, unknown>)[DOCID_FRONTMATTER_KEY] = docId;
						});
					},
					layout: {
						fontSize: this.settings.fontSize,
						lineHeight: this.settings.lineHeight,
						margin: this.settings.margin,
					},
					frontmatterAsTitleBlock: this.settings.frontmatterAsTitleBlock,
					skipUnchanged: options.auto === true,
				},
				(done, total) => notice.setMessage(`Sending ${done}/${total} to reMarkable…`),
			);

			this.settings.mappings = table;
			await this.saveSettings();
			reportResults(results, { quietWhenAllSkipped: options.auto === true });
		} finally {
			notice.hide();
		}
	}

	/**
	 * Pre-read all (nested) markdown embeds of a note so the pure preprocess
	 * step can resolve them synchronously.
	 */
	async buildEmbedMap(root: TFile): Promise<Map<string, EmbedContent>> {
		const map = new Map<string, EmbedContent>();
		let frontier: { linkpath: string; fromPath: string }[] = scanEmbeds(
			await this.app.vault.cachedRead(root),
			root.path,
		);
		for (let depth = 0; depth < MAX_EMBED_DEPTH && frontier.length > 0; depth++) {
			const next: { linkpath: string; fromPath: string }[] = [];
			for (const { linkpath, fromPath } of frontier) {
				if (map.has(linkpath)) continue;
				const target = this.app.metadataCache.getFirstLinkpathDest(
					linkpath.split("#")[0],
					fromPath,
				);
				if (!target) {
					map.set(linkpath, { kind: "missing" });
				} else if (IMAGE_EXTENSIONS.has(target.extension.toLowerCase())) {
					map.set(linkpath, { kind: "image", name: target.basename });
				} else if (target.extension === "md") {
					const content = await this.app.vault.cachedRead(target);
					map.set(linkpath, { kind: "markdown", content });
					next.push(...scanEmbeds(content, target.path));
				} else {
					map.set(linkpath, { kind: "image", name: target.name });
				}
			}
			frontier = next;
		}
		return map;
	}
}

function getFrontmatterValue(
	frontmatter: Record<string, unknown> | undefined,
	key: string,
): unknown {
	return frontmatter?.[key];
}

function scanEmbeds(content: string, fromPath: string): { linkpath: string; fromPath: string }[] {
	const found: { linkpath: string; fromPath: string }[] = [];
	for (const match of content.matchAll(EMBED_SCAN_RE)) {
		found.push({ linkpath: match[1].trim(), fromPath });
	}
	return found;
}

function collectMarkdownFiles(folder: TFolder): TFile[] {
	const files: TFile[] = [];
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === "md") files.push(child);
		else if (child instanceof TFolder) files.push(...collectMarkdownFiles(child));
	}
	return files;
}

function reportResults(
	results: SendResult[],
	options: { quietWhenAllSkipped?: boolean } = {},
): void {
	const failures = results.filter((r): r is Extract<SendResult, { ok: false }> => !r.ok);
	const missing = results.flatMap((r) => (r.ok ? r.missingEmbeds : []));
	if (failures.length === 0) {
		const sent = results.filter((r) => r.ok && r.skipped !== true);
		if (sent.length === 0 && options.quietWhenAllSkipped) return;
		const base =
			sent.length === 1
				? `Sent "${sent[0].path.split("/").pop()}" to reMarkable.`
				: `Sent ${sent.length} notes to reMarkable.`;
		new Notice(missing.length > 0 ? `${base} (${missing.length} embeds not found)` : base);
	} else {
		const detail = failures
			.slice(0, 3)
			.map((f) => `${f.path.split("/").pop()}: ${f.error}`)
			.join("\n");
		new Notice(
			`${results.length - failures.length}/${results.length} sent; ${failures.length} failed.\n${detail}`,
			10000,
		);
	}
}

/** Obsidian requestUrl adapter — CORS-free and mobile-safe (N7). */
const obsidianHttp: HttpClient = async (request) => {
	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers: request.headers,
		body: request.body,
		throw: false,
	});
	return {
		status: response.status,
		headers: response.headers,
		text: response.text ?? "",
		arrayBuffer: response.arrayBuffer,
	};
};
