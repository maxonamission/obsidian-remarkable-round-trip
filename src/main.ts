/**
 * reMarkable Round-Trip — Obsidian plugin edge (PRD F1, F4, F5).
 *
 * Everything Obsidian-specific lives here: commands, context menus, vault
 * access and the requestUrl-based HTTP adapter (mobile-safe, N7). The actual
 * pipeline (preprocess → PDF → upload → mapping) is pure and lives in src/.
 */

import { Menu, Plugin, TAbstractFile, TFile, TFolder, requestUrl } from "obsidian";
import { notify, progressNotice, updateProgress } from "./notify";
import { DEFAULT_SETTINGS, RoundTripSettings, RoundTripSettingTab } from "./settings";
import { remarkable } from "rmapi-js";
import { HttpClient } from "./transport/http";
import {
	OFFICIAL_ENDPOINTS,
	RemarkableCloudClient,
	rmfakecloudEndpoints,
} from "./transport/cloud";
import { installFetchShim, ShimTransport } from "./transport/fetchshim";
import { MirrorTransport, toTransportError } from "./transport/mirror";
import { describeDiagnosis, diagnoseCloud } from "./transport/diagnose";
import { EmbedContent } from "./preprocess/preprocess";
import { DOCID_FRONTMATTER_KEY } from "./id/docid";
import { NoteInput, sendBatch, SendResult } from "./sync/send";
import {
	DocumentFile,
	ImportedMark,
	PullResult,
	StrokeRenderRequest,
	pullAnnotations,
} from "./incoming/pull";
import { renderImportReport } from "./incoming/report";
import { paintPlan, planRender } from "./incoming/strokerender";
import { parseBlocks } from "./convert/mdblocks";
import { PdfLayout, renderPdf } from "./convert/pdf";
import { MappingEntry, contentHash } from "./id/mapping";
import { preprocess } from "./preprocess/preprocess";
import {
	companionPath,
	renderAnnotationBlock,
	upsertAnnotationBlock,
} from "./incoming/annotationnote";
import { WatchQueue } from "./sync/watcher";
import { flattenSelection } from "./sync/selection";

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
			id: "check-cloud-status",
			name: "Check reMarkable cloud status (read-only)",
			callback: () => void this.checkCloudStatus(),
		});

		this.addCommand({
			id: "import-annotations",
			name: "Import annotations from reMarkable",
			callback: () => void this.pullAnnotations(),
		});

		this.addCommand({
			id: "import-annotations-force",
			name: "Re-import all annotations (ignore what was already imported)",
			callback: () => void this.pullAnnotations({ force: true }),
		});

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

		// Multi-selection in the file explorer: Obsidian fires `files-menu`
		// instead of `file-menu`. The selection can mix notes and folders.
		this.registerEvent(
			this.app.workspace.on("files-menu", (menu: Menu, selection: TAbstractFile[]) => {
				const notes = collectFromSelection(selection);
				if (notes.length === 0) return;
				menu.addItem((item) =>
					item
						.setTitle(
							notes.length === 1
								? "Send 1 note to reMarkable"
								: `Send ${notes.length} notes to reMarkable`,
						)
						.setIcon("send")
						.onClick(() => void this.sendFiles(notes)),
				);
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
			notify("No markdown notes to send.");
			return;
		}
		const client = this.createClient();
		if (!client.isRegistered) {
			notify("Not paired with a reMarkable account yet — open the plugin settings first.");
			return;
		}

		// Folder mirroring (GP_E2_S7): one rmapi-js session per send-run so the
		// folder listing is fetched once and reused across the batch. When the
		// mirroring API is unreachable we degrade to root uploads instead of
		// refusing to send (N3 — and a beta tester hit exactly this on mobile,
		// GP_E2_S12).
		let mirror: MirrorTransport | null = null;
		let mirroringDegraded = false;
		if (this.settings.mirrorFolders) {
			try {
				const api = await remarkable(this.settings.deviceToken, this.rmapiOptions());
				mirror = new MirrorTransport(api, this.settings.deviceBaseFolder);
			} catch (error) {
				mirroringDegraded = true;
				console.error("reMarkable Round-Trip: folder mirroring unavailable", error);
				notify(
					"Could not reach the reMarkable folder API — sending to the device root instead. " +
						"Your notes are still delivered.",
					8000,
				);
			}
		}

		const notice = progressNotice(`Sending 0/${files.length} to reMarkable…`);
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
								upload: (fileName, bytes, uploadOptions) =>
									activeMirror
										.upload(fileName, bytes, uploadOptions)
										.catch((error: unknown) => {
											throw toTransportError(error);
										}),
							}
						: client,
					format: this.settings.outputFormat,
					resolveParent: activeMirror
						? (notePath) =>
								activeMirror
									.ensureFolderPath(notePath.split("/").slice(0, -1).join("/"))
									.catch((error: unknown) => {
										// Losing the folder is not worth losing the note:
										// deliver it to the device root instead (N3).
										mirroringDegraded = true;
										console.error(
											`reMarkable Round-Trip: folder for "${notePath}" unavailable`,
											toTransportError(error).message,
										);
										return "";
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
				(done, total) => updateProgress(notice, `Sending ${done}/${total} to reMarkable…`),
			);

			this.settings.mappings = table;
			await this.saveSettings();
			reportResults(results, {
				quietWhenAllSkipped: options.auto === true,
				mirroringDegraded: mirroringDegraded && mirror !== null,
			});
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

	/**
	 * Read-only account check (GP_E3_S5): tells a user whether a sync problem
	 * lives in the cloud or on the tablet, without touching anything.
	 */
	async checkCloudStatus(): Promise<void> {
		if (this.settings.deviceToken === "") {
			notify("Not paired with a reMarkable account yet — open the plugin settings first.");
			return;
		}
		const notice = progressNotice("Reading your reMarkable cloud account…");
		try {
			const api = await remarkable(this.settings.deviceToken, this.rmapiOptions());
			const diagnosis = await diagnoseCloud(
				{
					getRootHash: () => api.raw.getRootHash(),
					listItems: () => api.listItems(true),
				},
				this.settings.mappings,
			);
			const report = describeDiagnosis(diagnosis);
			// On mobile a Notice scrolls away and there is no console to open,
			// so put the report on the clipboard: it can be pasted into a note
			// or a bug report.
			let copied = false;
			try {
				await navigator.clipboard.writeText(report);
				copied = true;
			} catch {
				// Clipboard access can be denied; the notice below still shows it.
			}
			notify(copied ? `${report}\n\n(Copied to clipboard.)` : report, 30000);
		} catch (error) {
			notify(toTransportError(error).message, 15000);
		} finally {
			notice.hide();
		}
	}

	/**
	 * Import annotations for every note we have sent (F10/F11). Runs on an
	 * explicit command only — the vault is never written to behind your back.
	 */
	async pullAnnotations(options: { force?: boolean } = {}): Promise<void> {
		const mappings = Object.keys(this.settings.mappings).length;
		if (mappings === 0) {
			notify("Nothing to import yet — send a note to your reMarkable first.");
			return;
		}
		if (this.settings.deviceToken === "") {
			notify("Not paired with a reMarkable account yet — open the plugin settings first.");
			return;
		}

		const log: string[] = [];
		const startedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
		const notice = progressNotice(`Checking ${mappings} document(s) for annotations…`);
		try {
			const api = await remarkable(this.settings.deviceToken, this.rmapiOptions());
			const { results, table } = await pullAnnotations(
				this.settings.mappings,
				{
					force: options.force,
					log: (line) => log.push(line),
					listDocumentHashes: async () => {
						const items = await api.listItems(true);
						return new Map(
							items
								.filter((item) => item.type === "DocumentType")
								.map((item) => [item.id, item.hash]),
						);
					},
					listDocumentFiles: async (deviceDocId, hash) => {
						// The document's file index is addressed as `<id>.docSchema`
						// — the same name rmapi-js uses internally. Passing the bare
						// id returned nothing (GP_E3_S6).
						const { entries } = await api.raw.getEntries(`${deviceDocId}.docSchema`, hash);
						return entries.map((entry): DocumentFile => ({ id: entry.id, hash: entry.hash }));
					},
					readFile: (file) => api.raw.getText(file.id, file.hash),
					readBytes: (file) => api.raw.getHash(file.id, file.hash),
					renderStrokes: this.settings.importHandwriting
						? (request) => this.renderHandwriting(request)
						: undefined,
					loadLayout: (entry) => this.reproduceLayout(entry),
					writeAnnotations: (entry, highlights, marks) =>
						this.writeAnnotations(entry.notePath, highlights, marks),
				},
				(done, total) => updateProgress(notice, `Checking ${done}/${total} for annotations…`),
			);
			this.settings.mappings = table;
			await this.saveSettings();

			const report = `${renderImportReport({
				results,
				forced: options.force === true,
				startedAt,
				pluginVersion: this.manifest.version,
				handwritingEnabled: this.settings.importHandwriting,
			})}\n\n--- details ---\n${log.join("\n")}`;
			await this.deliverReport(report);
			reportPullResults(results);
		} catch (error) {
			const failure = toTransportError(error).message;
			await this.deliverReport(
				`reMarkable Round-Trip — import report (${startedAt})\nplugin ${this.manifest.version}\n\n` +
					`Run failed: ${failure}\n\n--- details ---\n${log.join("\n")}`,
			);
			notify(failure, 10000);
		} finally {
			notice.hide();
		}
	}

	/**
	 * Make a diagnostic report reachable on mobile: written to a note in the
	 * vault (so it survives and can be shared) and copied to the clipboard.
	 */
	private async deliverReport(report: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(report);
		} catch {
			// Clipboard may be denied; the note below is the durable copy.
		}
		try {
			const path = "reMarkable Round-Trip log.md";
			const existing = this.app.vault.getFileByPath(path);
			const body = `\`\`\`\n${report}\n\`\`\`\n`;
			if (existing) {
				await this.app.vault.modify(existing, body);
			} else {
				await this.app.vault.create(path, body);
			}
		} catch {
			// Writing the log must never break the import itself.
		}
	}

	/**
	 * Reproduce the page layout of a sent document, so imported ink can be
	 * quoted against the sentence it was written next to (GP_E3_S8).
	 *
	 * Not stored but recomputed: a layout map is far bigger than the note it
	 * describes. That only works while the note still matches what was sent,
	 * so the content hash decides — and the typography comes from the upload,
	 * not from today's settings.
	 */
	private async reproduceLayout(entry: MappingEntry): Promise<PdfLayout | null> {
		const typography = entry.pdfLayout;
		if (typography === undefined) return null; // EPUB, or sent before 0.8.0
		const file = this.app.vault.getFileByPath(entry.notePath);
		if (file === null) return null;

		const embeds = await this.buildEmbedMap(file);
		const pre = preprocess(await this.app.vault.cachedRead(file), {
			resolveEmbed: (linkpath) => embeds.get(linkpath) ?? { kind: "missing" },
			frontmatterAsTitleBlock: this.settings.frontmatterAsTitleBlock,
		});
		// A changed note means the geometry no longer matches the document on
		// the device; quoting from it would put the wrong sentence under the
		// ink, which is worse than no quote at all (N3).
		if (contentHash(pre.markdown) !== entry.contentHash) return null;

		const { layout } = await renderPdf(
			parseBlocks(pre.markdown),
			{ title: file.basename, docId: entry.docId },
			typography,
		);
		return layout;
	}

	/**
	 * Rasterise one handwritten remark to PNG and store it in the vault (F12).
	 * Canvas lives only here, at the edge; the geometry is planned by the
	 * pure renderer. Returns the vault path to embed, or null for ink that
	 * turned out to be empty.
	 */
	private async renderHandwriting(request: StrokeRenderRequest): Promise<string | null> {
		const plan = planRender(request.strokes);
		if (plan === null) return null;

		const canvas = document.createElement("canvas");
		canvas.width = plan.width;
		canvas.height = plan.height;
		const context = canvas.getContext("2d");
		if (context === null) throw new Error("no 2D canvas available for rendering");
		paintPlan(context, plan);

		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob((result) => resolve(result), "image/png"),
		);
		if (blob === null) throw new Error("could not encode the page as PNG");
		const buffer = await blob.arrayBuffer();

		const folder = this.settings.handwritingFolder.replace(/^\/+|\/+$/g, "");
		if (folder !== "" && !this.app.vault.getFolderByPath(folder)) {
			await this.app.vault.createFolder(folder);
		}
		// Deterministic name: a re-import overwrites the remark instead of
		// piling up copies next to it.
		const page = String(request.page).padStart(2, "0");
		const name = `${request.deviceDocId}-p${page}-${request.remark}.png`;
		const path = folder === "" ? name : `${folder}/${name}`;
		const existing = this.app.vault.getFileByPath(path);
		if (existing) {
			await this.app.vault.modifyBinary(existing, buffer);
		} else {
			await this.app.vault.createBinary(path, buffer);
		}
		return path;
	}

	/** Write one note's annotations to its configured destination (F11). */
	private async writeAnnotations(
		notePath: string,
		highlights: Parameters<typeof renderAnnotationBlock>[0]["highlights"],
		marks: ImportedMark[] = [],
	): Promise<void> {
		const sourceName = (notePath.split("/").pop() ?? notePath).replace(/\.md$/i, "");
		const block = renderAnnotationBlock({
			sourcePath: notePath,
			sourceName,
			highlights,
			marks,
			importedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
		});

		const targetPath =
			this.settings.annotationTarget === "source"
				? notePath
				: companionPath(notePath, this.settings.annotationFolder);

		const existing = this.app.vault.getFileByPath(targetPath);
		if (existing) {
			const current = await this.app.vault.read(existing);
			await this.app.vault.modify(existing, upsertAnnotationBlock(current, block));
			return;
		}
		// A companion note may need its folder created first.
		const folder = targetPath.split("/").slice(0, -1).join("/");
		if (folder !== "" && !this.app.vault.getFolderByPath(folder)) {
			await this.app.vault.createFolder(folder);
		}
		await this.app.vault.create(targetPath, `${block}\n`);
	}
}

function reportPullResults(results: PullResult[]): void {
	const failures = results.filter((r): r is Extract<PullResult, { ok: false }> => !r.ok);
	const imported = results.filter((r) => r.ok && r.skipped !== true);
	const total = imported.reduce((sum, r) => sum + (r.ok ? r.highlightCount : 0), 0);

	if (failures.length > 0) {
		const detail = failures
			.slice(0, 3)
			.map((f) => `${f.notePath.split("/").pop()}: ${f.error}`)
			.join("\n");
		notify(`${failures.length} document(s) could not be imported.\n${detail}`, 10000);
		return;
	}
	if (imported.length === 0) {
		notify("No new annotations — everything is already up to date.");
		return;
	}
	notify(`Imported ${total} highlight(s) from ${imported.length} document(s).`);
}

function getFrontmatterValue(
	frontmatter: Record<string, unknown> | undefined,
	key: string,
): unknown {
	return frontmatter?.[key];
}

function scanEmbeds(
	content: string,
	fromPath: string,
): { linkpath: string; fromPath: string }[] {
	const found: { linkpath: string; fromPath: string }[] = [];
	for (const match of content.matchAll(EMBED_SCAN_RE)) {
		found.push({ linkpath: match[1].trim(), fromPath });
	}
	return found;
}

/** Adapt Obsidian's TFile/TFolder tree to the pure selection flattener. */
function collectFromSelection(selection: TAbstractFile[]): TFile[] {
	return flattenSelection(selection, (item) => {
		if (item instanceof TFile) {
			return item.extension === "md" ? { kind: "note" } : { kind: "other" };
		}
		if (item instanceof TFolder) {
			return { kind: "folder", children: item.children };
		}
		return { kind: "other" };
	}) as TFile[];
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
	options: { quietWhenAllSkipped?: boolean; mirroringDegraded?: boolean } = {},
): void {
	if (options.mirroringDegraded) {
		notify(
			"Some folders could not be created on the device — those notes went to the root.",
			8000,
		);
	}
	const failures = results.filter((r): r is Extract<SendResult, { ok: false }> => !r.ok);
	const missing = results.flatMap((r) => (r.ok ? r.missingEmbeds : []));
	if (failures.length === 0) {
		const sent = results.filter((r) => r.ok && r.skipped !== true);
		if (sent.length === 0 && options.quietWhenAllSkipped) return;
		const base =
			sent.length === 1
				? `Sent "${sent[0].path.split("/").pop()}" to reMarkable.`
				: `Sent ${sent.length} notes to reMarkable.`;
		notify(missing.length > 0 ? `${base} (${missing.length} embeds not found)` : base);
	} else {
		const detail = failures
			.slice(0, 3)
			.map((f) => `${f.path.split("/").pop()}: ${f.error}`)
			.join("\n");
		notify(
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
