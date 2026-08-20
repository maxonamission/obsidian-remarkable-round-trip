/**
 * reMarkable Round-Trip — Obsidian plugin edge (PRD F1, F4, F5).
 *
 * Everything Obsidian-specific lives here: commands, context menus, vault
 * access and the requestUrl-based HTTP adapter (mobile-safe, N7). The actual
 * pipeline (preprocess → PDF → upload → mapping) is pure and lives in src/.
 */

import { Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, requestUrl } from "obsidian";
import { notify, progressNotice, updateProgress } from "./notify";
import {
	DEFAULT_SETTINGS,
	RoundTripSettings,
	RoundTripSettingTab,
	extrasFrom,
	sendLayout,
	settingsFrom,
	storedFrom,
} from "./settings";
import { LayoutChoiceModal } from "./layoutmodal";
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
import { NoteInput, SendFormat, sendBatch, SendResult } from "./sync/send";
import {
	DocumentFile,
	ImportedMark,
	PullResult,
	SourceState,
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
	AnnotationOutcome,
	companionPath,
	renderAnnotationBlock,
	upsertAnnotationBlock,
} from "./incoming/annotationnote";
import { WatchQueue } from "./sync/watcher";
import { RawSyncApi, readTextNotebook, sendTextNotebook } from "./transport/textnotebook";
import { TextImportOutcome, importEditedText, splitFrontmatter } from "./sync/textimport";
import { TextConflictModal } from "./textconflictmodal";
import { flattenSelection, relativeFolderPath } from "./sync/selection";
import { shouldAnnounceUpdate } from "./updatenotice";

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
	/** Unknown data.json keys, preserved across saves (see extrasFrom). */
	private extraData: Record<string, unknown> = {};
	/** Layouts rebuilt during one import run, by document id (GP_E3_S12). */
	private readonly layoutCache = new Map<string, PdfLayout | null>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new RoundTripSettingTab(this.app, this));
		this.setupWatcher();
		this.setupFetchShim();

		// Subtle "what's changed" notice (GP_E5_S3) — deferred to layout-ready
		// so it never adds to startup noise.
		this.app.workspace.onLayoutReady(() => {
			void this.checkForUpdateNotice();
		});

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

		// One note, not the whole account (GP_E5_S14): checking a single
		// freshly-reviewed note deserves the same precision as sending one.
		this.addCommand({
			id: "import-annotations-current-note",
			name: "Import annotations from reMarkable (current note)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || this.annotationEntry(file) === undefined) return false;
				if (!checking) void this.pullAnnotations({ only: file });
				return true;
			},
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

		this.addCommand({
			id: "send-current-note-choose-layout",
			name: "Send current note to reMarkable (choose layout)",
			checkCallback: (checking) => {
				// EPUB reflows: there is no layout to choose (the settings hide
				// the layout section there for the same reason).
				if (this.settings.outputFormat !== "pdf") return false;
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) this.sendWithLayoutChoice([file], `"${file.basename}"`);
				return true;
			},
		});

		// Write-mode (F16, GP_E7_S2): an explicit per-send choice, never a
		// default — the note travels as a typed-text notebook you edit with
		// the keyboard, not as a review copy you annotate with the pen.
		this.addCommand({
			id: "send-current-note-editable-text",
			name: "Send current note to reMarkable as editable text",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.sendFiles([file], { format: "text" });
				return true;
			},
		});

		// The way back (F17, GP_E7_S3): equally explicit, equally per note —
		// only offered for notes whose last send was a write-mode send.
		this.addCommand({
			id: "import-edited-text-current-note",
			name: "Get edited text back from reMarkable (current note)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const entry = file === null ? undefined : this.writeModeEntry(file);
				if (!file || entry === undefined) return false;
				if (!checking) void this.importEditedTextFor(file);
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
					// ONE extra entry that opens the layout modal (GP_E6_S10) —
					// deliberately not an entry per preset. PDF only: an EPUB
					// reflows and has no layout to choose.
					if (this.settings.outputFormat === "pdf") menu.addItem((item) =>
						item
							.setTitle("Send to reMarkable (choose layout…)")
							.setIcon("send")
							.onClick(() => this.sendWithLayoutChoice([file], `"${file.basename}"`)),
					);
					// Write-mode (GP_E7_S2): per note, on purpose — an editable
					// text document is a working copy you pick deliberately, not
					// a bulk format, so folders keep review sends only.
					menu.addItem((item) =>
						item
							.setTitle("Send to reMarkable as editable text")
							.setIcon("pencil")
							.onClick(() => void this.sendFiles([file], { format: "text" })),
					);
					// …and the way back (GP_E7_S3), only where it applies.
					if (this.writeModeEntry(file) !== undefined) menu.addItem((item) =>
						item
							.setTitle("Get edited text from reMarkable")
							.setIcon("pencil")
							.onClick(() => void this.importEditedTextFor(file)),
					);
					// Annotations of exactly this note (GP_E5_S14) — only shown
					// once the note has a review copy on the device.
					if (this.annotationEntry(file) !== undefined) menu.addItem((item) =>
						item
							.setTitle("Import annotations from reMarkable")
							.setIcon("import")
							.onClick(() => void this.pullAnnotations({ only: file })),
					);
				}
				if (file instanceof TFolder) {
					menu.addItem((item) =>
						item
							.setTitle("Send folder to reMarkable")
							.setIcon("send")
							// The sent folder keeps its internal structure on the
							// device even when vault mirroring is off (GP_E5_S2):
							// paths are made relative to the folder's parent, so
							// the folder itself is created at the device root.
							.onClick(() =>
								void this.sendFiles(collectMarkdownFiles(file), {
									structureRoot: folderParentPath(file),
								}),
							),
					);
					if (this.settings.outputFormat === "pdf") menu.addItem((item) =>
						item
							.setTitle("Send folder to reMarkable (choose layout…)")
							.setIcon("send")
							.onClick(() =>
								this.sendWithLayoutChoice(
									collectMarkdownFiles(file),
									`folder "${file.name}"`,
									{ structureRoot: folderParentPath(file) },
								),
							),
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
				if (this.settings.outputFormat === "pdf") menu.addItem((item) =>
					item
						.setTitle(
							notes.length === 1
								? "Send 1 note to reMarkable (choose layout…)"
								: `Send ${notes.length} notes to reMarkable (choose layout…)`,
						)
						.setIcon("send")
						.onClick(() =>
							this.sendWithLayoutChoice(
								notes,
								notes.length === 1 ? "1 note" : `${notes.length} notes`,
							),
						),
				);
			}),
		);
	}

	async loadSettings(): Promise<void> {
		const stored = ((await this.loadData()) ?? {}) as Partial<RoundTripSettings>;
		this.settings = settingsFrom(stored);
		// Unknown data.json keys — a newer version's settings, hand-added
		// flags — ride along in extraData so a save does not destroy them
		// (bevinding eigenaar 2026-08-13; the spike flag that surfaced it is
		// gone since GP_E7_S2, the preservation stays).
		this.extraData = extrasFrom(stored);
	}

	/**
	 * Obsidian calls this when data.json changed outside this running plugin
	 * — Obsidian Sync, or a hand edit while the app runs. Without it, the
	 * next save would write the stale in-memory snapshot back and erase that
	 * edit (reviewvondst 0.35.1).
	 */
	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		this.setupWatcher();
		this.setupFetchShim();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(storedFrom(this.settings, this.extraData));
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
		// Reinstalling swaps in a fresh concurrency gate; requests already
		// holding a slot in the old one finish there (briefly allowing up to
		// 2× the cap in flight), while its queued tail is rejected by
		// restore() — accepted: a settings change mid-send may abort that
		// send's remaining mirror calls, which resurface as a clear error.
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
		// The default scope: the window this bundle (and rmapi-js inside it)
		// was loaded in — the only realm whose `fetch` rmapi-js ever calls.
		// Passing activeWindow here would patch a popped-out window instead
		// whenever one had focus during a settings save, leaving the real
		// fetch CORS-bound on desktop (GP_E5_S9).
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
	/**
	 * GP_E5_S3: show a one-time notice when the installed version stepped up a
	 * minor or major version since last seen — never for a patch bump, and
	 * never when the toggle is off. The stored version always advances when it
	 * differs (patch bump or toggle-off included), so a later minor/major jump
	 * is judged from the right baseline.
	 */
	private async checkForUpdateNotice(): Promise<void> {
		const current = this.manifest.version;
		const prev = this.settings.lastSeenVersion;

		if (shouldAnnounceUpdate(prev, current) && this.settings.showUpdateNotice) {
			const [major, minor] = current.split(".");
			const frag = createFragment((f) => {
				f.appendText(`reMarkable Round-Trip updated to ${major}.${minor} — `);
				f.createEl("a", {
					text: "see what's new",
					href: `https://github.com/maxonamission/obsidian-remarkable-round-trip/releases/tag/${current}`,
				});
			});
			new Notice(frag, 8000);
		}

		if (current !== prev) {
			this.settings.lastSeenVersion = current;
			await this.saveSettings();
		}
	}

	/**
	 * Open the per-send layout modal, then send with the chosen layout
	 * (GP_E6_S10). The refusals sendFiles would give (not paired, nothing to
	 * send) surface BEFORE the modal opens — filling in a dialog first and
	 * being refused after is the wrong order.
	 */
	private sendWithLayoutChoice(
		files: TFile[],
		subject: string,
		options: { structureRoot?: string } = {},
	): void {
		if (files.length === 0) {
			notify("No markdown notes to send.");
			return;
		}
		if (!this.createClient().isRegistered) {
			notify("Not paired with a reMarkable account yet — open the plugin settings first.");
			return;
		}
		new LayoutChoiceModal(this.app, this.settings, subject, (choice) => {
			void this.sendFiles(files, {
				...options,
				layout: sendLayout({ ...this.settings, ...choice }),
			});
		}).open();
	}

	async sendFiles(
		files: TFile[],
		options: {
			auto?: boolean;
			structureRoot?: string;
			/** One-send override (GP_E6_S10); omitted = the stored settings. */
			layout?: ReturnType<typeof sendLayout>;
			/**
			 * One-send format override (GP_E7_S2): "text" sends the note as an
			 * editable typed-text notebook instead of a review copy. Only ever
			 * set explicitly — the stored settings cannot choose it.
			 */
			format?: SendFormat;
		} = {},
	): Promise<void> {
		if (files.length === 0) {
			notify("No markdown notes to send.");
			return;
		}
		const client = this.createClient();
		if (!client.isRegistered) {
			notify("Not paired with a reMarkable account yet — open the plugin settings first.");
			return;
		}
		const format: SendFormat = options.format ?? this.settings.outputFormat;

		// Folder mirroring (GP_E2_S7): one rmapi-js session per send-run so the
		// folder listing is fetched once and reused across the batch. When the
		// mirroring API is unreachable we degrade to root uploads instead of
		// refusing to send (N3 — and a beta tester hit exactly this on mobile,
		// GP_E2_S12). A folder send keeps its internal structure even with
		// vault mirroring off (GP_E5_S2): the folder tree then goes to the
		// device root, without the base folder or the full vault path.
		//
		// A write-mode send (GP_E7_S2) needs the same session for the upload
		// itself — there is no simple-endpoint fallback for typed text, so
		// where a review send degrades to root uploads, a text send refuses
		// with the reason instead of silently delivering the wrong format.
		const structureOnly = !this.settings.mirrorFolders && options.structureRoot !== undefined;
		const mirrorFoldersActive = this.settings.mirrorFolders || structureOnly;
		let mirror: MirrorTransport | null = null;
		let rawApi: RawSyncApi | null = null;
		let mirroringDegraded = false;
		let mirroringDegradedReason: string | null = null;
		if (mirrorFoldersActive || format === "text") {
			try {
				const api = await remarkable(this.settings.deviceToken, this.rmapiOptions());
				rawApi = api.raw;
				mirror = new MirrorTransport(
					api,
					structureOnly ? "" : this.settings.deviceBaseFolder,
				);
			} catch (error) {
				console.error("reMarkable Round-Trip: sync API unavailable", error);
				if (format === "text") {
					notify(
						`Could not reach the reMarkable sync API, which editable-text sends need — nothing was sent. (${
							toTransportError(error).message
						})`,
						8000,
					);
					return;
				}
				mirroringDegraded = true;
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
			const activeRaw = rawApi;
			const { results, table } = await sendBatch(
				notes,
				this.settings.mappings,
				{
					client: {
						upload: (fileName, bytes, uploadOptions) =>
							activeMirror && mirrorFoldersActive
								? activeMirror
										.upload(fileName, bytes, uploadOptions)
										.catch((error: unknown) => {
											throw toTransportError(error);
										})
								: client.upload(fileName, bytes, uploadOptions),
						uploadText: activeRaw
							? (visibleName, markdown, uploadOptions) =>
									sendTextNotebook(activeRaw, visibleName, markdown, {
										parentId: uploadOptions.parentId,
									}).catch((error: unknown) => {
										throw toTransportError(error);
									})
							: undefined,
					},
					format,
					resolveParent: activeMirror && mirrorFoldersActive
						? (notePath) => {
								const dir = notePath.split("/").slice(0, -1).join("/");
								const target = structureOnly
									? relativeFolderPath(dir, options.structureRoot ?? "")
									: dir;
								return activeMirror
									.ensureFolderPath(target)
									.catch((error: unknown) => {
										// Losing the folder is not worth losing the note:
										// deliver it to the device root instead (N3). Keep
										// the first reason so the user hears *why* — the
										// busy-syncing guidance must reach them (GP_E5_S1),
										// not just the console.
										mirroringDegraded = true;
										const message = toTransportError(error).message;
										mirroringDegradedReason ??= message;
										console.error(
											`reMarkable Round-Trip: folder for "${notePath}" unavailable`,
											message,
										);
										return "";
									});
							}
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
					// The stored settings' layout, or the one-send override from
					// the layout modal (GP_E6_S10) — both composed by sendLayout,
					// and always recorded per upload for layout reproduction.
					layout: options.layout ?? sendLayout(this.settings),
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
				mirroringDegradedReason: mirroringDegradedReason ?? undefined,
			});
		} finally {
			notice.hide();
		}
	}

	/** The mapping entry of a note whose LAST send was write-mode, if any. */
	private writeModeEntry(file: TFile): MappingEntry | undefined {
		const docId = getFrontmatterValue(
			this.app.metadataCache.getFileCache(file)?.frontmatter,
			DOCID_FRONTMATTER_KEY,
		);
		if (typeof docId !== "string") return undefined;
		const entry = this.settings.mappings[docId];
		return entry?.format === "text" ? entry : undefined;
	}

	/**
	 * Import the edited text of a write-mode note back into the note itself
	 * (F17, GP_E7_S3). The N5 guarantees — backup before touching, conflict
	 * ask, no silent merges — live in importEditedText; this edge only wires
	 * vault, transport and the conflict modal together. The note the user
	 * invoked this on IS the target, so a moved note needs no path chase.
	 */
	private async importEditedTextFor(file: TFile): Promise<void> {
		const entry = this.writeModeEntry(file);
		if (entry === undefined) {
			notify("This note's last send was not an editable-text send.");
			return;
		}
		if (this.settings.deviceToken === "") {
			notify("Not paired with a reMarkable account yet — open the plugin settings first.");
			return;
		}
		const notice = progressNotice(`Reading "${file.basename}" from the reMarkable…`);
		// Filled by readDeviceText below; a mobile user cannot open a console
		// (devicecheck 2026-08-19, twice), so what the device file looks like
		// must reach them through the vault log — ALWAYS, not only on
		// anchoring trouble: the third failed phone test delivered an old log
		// because the trouble-only guard had nothing to say, and left us
		// unable to tell "old plugin" from "anchors resolved yet still
		// wrong". Every text import now leaves its full trace.
		const diagnosis = { unanchored: 0, lines: [] as string[] };
		try {
			const api = await remarkable(this.settings.deviceToken, this.rmapiOptions());
			const { outcome, entry: updated } = await importEditedText(entry, {
				readDeviceText: async (target) => {
					try {
						const result = await readTextNotebook(api.raw, target.deviceDocId);
						diagnosis.unanchored = result.unanchored;
						diagnosis.lines = [
							`device ${target.deviceDocId}`,
							`${result.topology.length} item(s), ${result.unanchored} unanchored (unanchored items sit at the END of the text)`,
							"Item map (ids, anchors and lengths only — no content):",
							...result.topology.map((line) => `  ${line}`),
							"",
							`.rm files in the document (first one is read): ${result.pageFiles.join(", ")}`,
						];
						if (result.unanchored > 0) {
							console.warn(
								`reMarkable Round-Trip: ${result.unanchored} text item(s) had unresolvable anchors and were appended in file order`,
							);
						}
						return result;
					} catch (error) {
						if (error instanceof Error && error.message.includes("not found")) {
							return null;
						}
						throw error;
					}
				},
				readNote: () => this.app.vault.read(file),
				writeNote: (_target, content) => this.app.vault.modify(file, content),
				writeBackup: (target, content) => this.writePreviousVersion(file, target, content),
				writeAside: async (_target, markdown) => {
					const dir = file.parent === null || file.parent.path === "/" ? "" : file.parent.path;
					const path = `${dir === "" ? "" : `${dir}/`}${file.basename} (from reMarkable).md`;
					await this.writeVaultFile(path, markdown);
					return path;
				},
				chooseOnConflict: () =>
					new Promise((resolve) => {
						new TextConflictModal(this.app, file.basename, resolve).open();
					}),
			});
			if (outcome.kind === "imported" || outcome.kind === "conflict-replaced") {
				this.settings.mappings = {
					...this.settings.mappings,
					[updated.docId]: { ...updated, notePath: file.path },
				};
				await this.saveSettings();
			}
			await this.deliverReport(
				[
					`reMarkable Round-Trip — text import diagnosis (${new Date().toISOString().slice(0, 16).replace("T", " ")})`,
					`plugin ${this.manifest.version} · "${file.basename}"`,
					`outcome: ${outcome.kind}`,
					...diagnosis.lines,
				].join("\n"),
			);
			notify(
				describeTextImport(file.basename, outcome) +
					(diagnosis.unanchored === 0
						? ""
						: ` Note: ${diagnosis.unanchored} edit(s) could not be anchored and sit at the END of the text.`) +
					' Diagnosis written to "reMarkable Round-Trip log.md".',
				diagnosis.unanchored === 0 ? 10000 : 20000,
			);
		} catch (error) {
			notify(toTransportError(error).message, 10000);
		} finally {
			notice.hide();
		}
	}

	/**
	 * The safety-net copy (N5): the full previous note, in a `previous`
	 * folder under the import folder, named deterministically so a second
	 * import overwrites its own backup instead of piling up copies. The
	 * docId key is renamed in the copy — resolveNote finds notes by that id,
	 * and a backup carrying the live id could hijack a lookup after the
	 * original moved.
	 */
	private async writePreviousVersion(
		file: TFile,
		entry: MappingEntry,
		content: string,
	): Promise<string> {
		const base = this.settings.annotationFolder.replace(/^\/+|\/+$/g, "");
		const folder = base === "" ? "previous" : `${base}/previous`;
		const { head, body } = splitFrontmatter(content);
		const safeHead = head.replace(
			new RegExp(`^${DOCID_FRONTMATTER_KEY}(?=\\s*:)`, "m"),
			`${DOCID_FRONTMATTER_KEY}-previous`,
		);
		const path = `${folder}/${file.basename} (${entry.docId.slice(0, 8)}).md`;
		await this.writeVaultFile(path, safeHead + body);
		return path;
	}

	/** Create or overwrite a vault file, creating missing folders on the way. */
	private async writeVaultFile(path: string, content: string): Promise<void> {
		const dir = path.split("/").slice(0, -1).join("/");
		const segments = dir.split("/").filter((segment) => segment !== "");
		let prefix = "";
		for (const segment of segments) {
			prefix = prefix === "" ? segment : `${prefix}/${segment}`;
			if (this.app.vault.getFolderByPath(prefix) === null) {
				await this.app.vault.createFolder(prefix);
			}
		}
		const existing = this.app.vault.getFileByPath(path);
		if (existing !== null) await this.app.vault.modify(existing, content);
		else await this.app.vault.create(path, content);
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

	/** The mapping entry of a note whose last send was a REVIEW copy, if any. */
	private annotationEntry(file: TFile): MappingEntry | undefined {
		const docId = getFrontmatterValue(
			this.app.metadataCache.getFileCache(file)?.frontmatter,
			DOCID_FRONTMATTER_KEY,
		);
		if (typeof docId !== "string") return undefined;
		const entry = this.settings.mappings[docId];
		return entry === undefined || entry.format === "text" ? undefined : entry;
	}

	/**
	 * Import annotations for every note we have sent (F10/F11), or — with
	 * `only` (GP_E5_S14) — for exactly one note: the full run walks hundreds
	 * of mappings, and checking a single freshly-reviewed note deserves the
	 * same precision as sending one. Runs on an explicit command only — the
	 * vault is never written to behind your back.
	 */
	async pullAnnotations(options: { force?: boolean; only?: TFile } = {}): Promise<void> {
		let scope = this.settings.mappings;
		if (options.only !== undefined) {
			const entry = this.annotationEntry(options.only);
			if (entry === undefined) {
				notify(
					this.writeModeEntry(options.only) !== undefined
						? 'This note was sent as editable text — use "Get edited text back from reMarkable" instead.'
						: "This note has not been sent to the reMarkable yet.",
				);
				return;
			}
			scope = { [entry.docId]: entry };
		}
		const mappings = Object.keys(scope).length;
		if (mappings === 0) {
			notify("Nothing to import yet — send a note to your reMarkable first.");
			return;
		}
		if (this.settings.deviceToken === "") {
			notify("Not paired with a reMarkable account yet — open the plugin settings first.");
			return;
		}

		const log: string[] = [];
		this.layoutCache.clear();
		await this.reconcileNotePaths((line) => log.push(line));
		const startedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
		const notice = progressNotice(`Checking ${mappings} document(s) for annotations…`);
		try {
			const api = await remarkable(this.settings.deviceToken, this.rmapiOptions());
			const { results, table } = await pullAnnotations(
				scope,
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
					checkSource: (entry) => this.checkSource(entry),
					writeAnnotations: async (entry, highlights, marks, sourceState) =>
						this.writeAnnotations(
							entry.notePath,
							highlights,
							marks,
							await this.reproduceLayout(entry).catch(() => null),
							await this.readSourceBody(entry).catch(() => null),
							this.resolveNote(entry)?.path ?? entry.notePath,
							sourceState,
						),
				},
				(done, total) => updateProgress(notice, `Checking ${done}/${total} for annotations…`),
			);
			// A scoped run returns only its slice; merging keeps the rest.
			this.settings.mappings = { ...this.settings.mappings, ...table };
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
		// Rebuilding means typesetting the note again; one import asks for the
		// same layout twice (marks, then the annotated copy).
		const cached = this.layoutCache.get(entry.docId);
		if (cached !== undefined) return cached;
		const layout = await this.buildLayout(entry);
		this.layoutCache.set(entry.docId, layout);
		return layout;
	}

	/**
	 * The note a mapping points at. Obsidian lets you move and rename freely,
	 * so the path recorded at send time is a hint, not an identity — the
	 * `remarkable-id` in the frontmatter is (K3). Looking it up that way keeps
	 * a moved note working instead of quietly losing its annotations
	 * (GP_E3_S3).
	 */
	private resolveNote(entry: MappingEntry): TFile | null {
		const atPath = this.app.vault.getFileByPath(entry.notePath);
		if (atPath !== null) return atPath;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (frontmatter?.[DOCID_FRONTMATTER_KEY] === entry.docId) return file;
		}
		return null;
	}

	/**
	 * Bring the recorded paths back in line with the vault before a run, so a
	 * moved note keeps its annotations — and its companion note stays next to
	 * it rather than at the old address.
	 */
	private async reconcileNotePaths(log: (line: string) => void): Promise<void> {
		let changed = false;
		for (const entry of Object.values(this.settings.mappings)) {
			if (this.app.vault.getFileByPath(entry.notePath) !== null) continue;
			const found = this.resolveNote(entry);
			if (found === null || found.path === entry.notePath) continue;
			log(`note moved: ${entry.notePath} → ${found.path}`);
			this.settings.mappings = {
				...this.settings.mappings,
				[entry.docId]: { ...entry, notePath: found.path },
			};
			changed = true;
		}
		if (changed) await this.saveSettings();
	}

	/** Does the note still match the document that was sent? (F14) */
	private async checkSource(entry: MappingEntry): Promise<SourceState> {
		if (entry.pdfLayout === undefined) return "no-snapshot";
		const file = this.resolveNote(entry);
		if (file === null) return "missing";
		const moved = file.path !== entry.notePath;
		// Preprocess exactly as the layout rebuild does, or the two would
		// disagree about whether the note changed.
		const embeds = await this.buildEmbedMap(file);
		const pre = preprocess(await this.app.vault.cachedRead(file), {
			resolveEmbed: (linkpath) => embeds.get(linkpath) ?? { kind: "missing" },
			frontmatterAsTitleBlock: this.settings.frontmatterAsTitleBlock,
		});
		if (contentHash(pre.markdown) !== entry.contentHash) return "changed";
		return moved ? "moved" : "match";
	}

	/**
	 * The note's own markdown, frontmatter removed — what the marks get
	 * projected onto (GP_E3_S13).
	 */
	private async readSourceBody(entry: MappingEntry): Promise<string | null> {
		if (entry.pdfLayout === undefined) return null;
		const file = this.resolveNote(entry);
		if (file === null) return null;
		const raw = await this.app.vault.cachedRead(file);
		// Frontmatter belongs to the source note, not to a copy of its body.
		return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	}

	private async buildLayout(entry: MappingEntry): Promise<PdfLayout | null> {
		const typography = entry.pdfLayout;
		if (typography === undefined) return null; // EPUB, or sent before 0.8.0
		const file = this.resolveNote(entry);
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
			// Documents sent before 0.29.0 carry no typo version: replay the
			// behaviour they were typeset with (GP_E3_S15 lesson).
			{ ...typography, typo: typography.typo ?? 1 },
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

		// createEl rather than document.createElement: Obsidian's helper attaches
		// to the right document, which matters in a popped-out window.
		const canvas = createEl("canvas");
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
		layout: PdfLayout | null = null,
		source: string | null = null,
		currentPath: string = notePath,
		sourceState?: SourceState,
	): Promise<AnnotationOutcome> {
		// A moved note keeps its annotations beside it, not at the old address.
		const sourceName = (currentPath.split("/").pop() ?? currentPath).replace(/\.md$/i, "");
		const rendered = renderAnnotationBlock({
			sourcePath: currentPath,
			sourceName,
			highlights,
			marks,
			layout,
			source,
			inSourceNote: this.settings.annotationTarget === "source",
			styles: this.settings.markStyles,
			sourceChanged: sourceState === "changed",
			importedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
		});

		const targetPath =
			this.settings.annotationTarget === "source"
				? currentPath
				: companionPath(currentPath, this.settings.annotationFolder);

		const existing = this.app.vault.getFileByPath(targetPath);
		if (existing) {
			const current = await this.app.vault.read(existing);
			await this.app.vault.modify(existing, upsertAnnotationBlock(current, rendered.text));
			return rendered.outcome;
		}
		// A companion note may need its folder created first.
		const folder = targetPath.split("/").slice(0, -1).join("/");
		if (folder !== "" && !this.app.vault.getFolderByPath(folder)) {
			await this.app.vault.createFolder(folder);
		}
		await this.app.vault.create(targetPath, `${rendered.text}\n`);
		return rendered.outcome;
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
	// A note edited after it was sent still yields annotations, but unplaced
	// ones — say so here rather than only in the report (F14).
	const changed = imported.filter((r) => r.ok && r.scan?.sourceState === "changed").length;
	const conflict =
		changed > 0
			? `\n${changed} note(s) changed since they were sent, so their marks could not be ` +
				"placed in the text. Send them again."
			: "";
	notify(
		`Imported ${total} highlight(s) from ${imported.length} document(s).${conflict}`,
		changed > 0 ? 10000 : undefined,
	);
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

/** Vault path of the folder's parent, normalised: Obsidian's vault root is "/". */
function folderParentPath(folder: TFolder): string {
	const parent = folder.parent?.path ?? "";
	return parent === "/" ? "" : parent;
}

function collectMarkdownFiles(folder: TFolder): TFile[] {
	const files: TFile[] = [];
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === "md") files.push(child);
		else if (child instanceof TFolder) files.push(...collectMarkdownFiles(child));
	}
	return files;
}

/** One honest sentence per write-mode import outcome (GP_E7_S3). */
function describeTextImport(name: string, outcome: TextImportOutcome): string {
	switch (outcome.kind) {
		case "imported":
			return `"${name}" now carries the reMarkable text. Previous version: ${outcome.backupPath}`;
		case "conflict-replaced":
			return `"${name}" now carries the reMarkable text. The newer vault version is kept at ${outcome.backupPath}`;
		case "conflict-kept":
			return `"${name}" kept as it is. The reMarkable text is at ${outcome.asidePath}`;
		case "cancelled":
			return "Nothing changed.";
		case "unchanged":
			return `No differences — "${name}" and the reMarkable copy say the same.`;
		case "device-unchanged":
			return `The reMarkable copy of "${name}" has no edits — nothing to import.`;
		case "no-text":
			return "That document carries no typed text, so there is nothing to bring back.";
		case "not-on-device":
			return "The document is no longer on the reMarkable account — nothing was changed.";
		case "note-missing":
			return `Could not read "${name}" from the vault — nothing was changed.`;
		case "not-write-mode":
			return "This note's last send was not an editable-text send.";
	}
}

function reportResults(
	results: SendResult[],
	options: {
		quietWhenAllSkipped?: boolean;
		mirroringDegraded?: boolean;
		/** First transport explanation, e.g. the busy-syncing guidance (GP_E5_S1). */
		mirroringDegradedReason?: string;
	} = {},
): void {
	if (options.mirroringDegraded) {
		const reason = options.mirroringDegradedReason;
		notify(
			"Some folders could not be created on the device — those notes went to the root." +
				(reason ? ` ${reason}` : ""),
			10000,
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
