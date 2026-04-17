import {
	App,
	Editor,
	ItemView,
	MarkdownFileInfo,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	moment as obsidianMoment
} from "obsidian";

const VIEW_TYPE_TIMELINE = "timeline-stamp-view";
const TIMESTAMP_DATASET = "timelineIso";
const TIMESTAMP_CAPTURE_PATTERN =
	`(?:(==(?<text>[\\s\\S]*?)==)|(?<image>!\\[[^\\]]*\\]\\([^\\)]+\\)|!\\[\\[[^\\]]+\\]\\]))\\s*<span class="timeline-stamp-label" data-${TIMESTAMP_DATASET}="(?<iso>[^"]+)">(?<formatted>[^<]*)<\\/span>`;

type MomentStatic = typeof import("moment");
type MomentInstance = ReturnType<MomentStatic>;

const moment: MomentStatic = obsidianMoment as unknown as MomentStatic;

interface TimelineEntry {
	id: string;
	filePath: string;
	fileName: string;
	type: "text" | "image";
	timestamp: string;
	formatted: string;
	snippet: string;
	line: number;
}

interface TimeLineStampSettings {
	timestampFormat: string;
	autoOpenTimeline: boolean;
}

interface TimeLineStampData {
	settings: TimeLineStampSettings;
	entries: TimelineEntry[];
}

const DEFAULT_SETTINGS: TimeLineStampSettings = {
	timestampFormat: "YYYY-MM-DD HH:mm",
	autoOpenTimeline: false
};

const createDefaultData = (): TimeLineStampData => ({
	settings: { ...DEFAULT_SETTINGS },
	entries: []
});

interface TimelineRefreshable {
	refreshEntries(): void;
}

export default class TimeLineStampPlugin extends Plugin {
	private data: TimeLineStampData = createDefaultData();
	private refreshSubscribers: Set<TimelineRefreshable> = new Set();
	private scanIntervalId: number | null = null;
	private isScanning = false;

	async onload() {
		await this.loadPluginData();
		this.addSettingTab(new TimeLineStampSettingTab(this.app, this));

		this.registerView(VIEW_TYPE_TIMELINE, (leaf) => new TimelineView(leaf, this));
		this.addRibbonIcon("clock", "Toggle timeline", () => {
			void this.toggleTimelineView();
		});

		this.addCommand({
			id: "timestamp-selection-current",
			name: "Timestamp selection with current time",
			editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				const file = this.resolveFileFromContext(ctx);
				if (!file) {
					new Notice("Active file not available.");
					return;
				}
				const now = moment();
				await this.applyTimestamp(editor, file, now);
			}
		});

		this.addCommand({
			id: "timestamp-selection-custom",
			name: "Timestamp selection with chosen time",
			editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				const file = this.resolveFileFromContext(ctx);
				if (!file) {
					new Notice("Active file not available.");
					return;
				}
				const chosen = await this.promptForTimestamp(moment());
				if (!chosen) {
					return;
				}
				await this.applyTimestamp(editor, file, chosen);
			}
		});

		this.addCommand({
			id: "open-timeline",
			name: "Open timeline",
			callback: async () => {
				await this.revealTimelineView();
			}
		});

		this.startAutoScan();
	}

	onunload() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_TIMELINE).forEach((leaf) => leaf.detach());
		this.stopAutoScan();
		this.refreshSubscribers.clear();
	}

	registerTimelineView(view: TimelineRefreshable) {
		this.refreshSubscribers.add(view);
	}

	unregisterTimelineView(view: TimelineRefreshable) {
		this.refreshSubscribers.delete(view);
	}

	getEntries(): TimelineEntry[] {
		return this.data.entries.slice();
	}

	get settings(): TimeLineStampSettings {
		return this.data.settings;
	}

	async updateSettings(partial: Partial<TimeLineStampSettings>) {
		this.data.settings = { ...this.data.settings, ...partial };
		await this.savePluginData();
		this.notifySubscribers();
	}

	private resolveFileFromContext(ctx?: MarkdownView | MarkdownFileInfo): TFile | null {
		if (!ctx) {
			return this.app.workspace.getActiveFile();
		}
		if (ctx instanceof MarkdownView) {
			return ctx.file ?? null;
		}
		return ctx.file ?? null;
	}

	private async applyTimestamp(editor: Editor, file: TFile, stamp: MomentInstance) {
		const selection = editor.getSelection();
		if (!selection || selection.length === 0) {
			new Notice("Highlight text or an image first.");
			return;
		}

		const cursor = editor.getCursor("from");
		const iso = stamp.toISOString(true);
		const id = this.buildEntryId(file.path, iso, cursor.line);
		const formatted = this.formatMoment(stamp);
		const type = this.detectSelectionType(selection);
		const snippet = this.createSnippet(selection, type);

		const replacement = this.buildReplacement(selection, type, formatted, iso);
		editor.replaceSelection(replacement);

		const entry: TimelineEntry = {
			id,
			filePath: file.path,
			fileName: file.basename,
			type,
			timestamp: iso,
			formatted,
			snippet,
			line: cursor.line
		};

		await this.addTimelineEntry(entry);

		if (this.settings.autoOpenTimeline) {
			await this.revealTimelineView();
		}

		new Notice(`Added entry at ${formatted}.`);
	}

	private detectSelectionType(selection: string): "text" | "image" {
		const trimmed = selection.trim();
		const imageEmbedPattern = /^!\[[^\]]*\]\([^)]+\)$/;
		const wikiPattern = /^!\[\[[^\]]+\]\]$/;
		if (wikiPattern.test(trimmed) || imageEmbedPattern.test(trimmed)) {
			return "image";
		}
		return "text";
	}

	private createSnippet(selection: string, type: "text" | "image"): string {
		if (type === "image") {
			const match = selection.match(/\[\[([^\]]+)\]\]/);
			if (match) {
				return match[1];
			}
			const altMatch = selection.match(/!\[([^\]]*)\]\(([^)]+)\)/);
			if (altMatch) {
				return altMatch[1] || altMatch[2];
			}
			return selection.trim();
		}

		const sanitized = selection.replace(/\s+/g, " ").trim();
		return sanitized.length > 120 ? sanitized.slice(0, 117) + "..." : sanitized;
	}

	private buildReplacement(selection: string, type: "text" | "image", formatted: string, iso: string): string {
		const stampLabel = `<span class="timeline-stamp-label" data-${TIMESTAMP_DATASET}="${iso}">${formatted}</span>`;
		const trailingWhitespaceMatch = selection.match(/\s+$/);
		const trailing = trailingWhitespaceMatch ? trailingWhitespaceMatch[0] : "";
		const core = trailingWhitespaceMatch ? selection.slice(0, selection.length - trailing.length) : selection;

		if (type === "image") {
			const needsNewline = !core.endsWith("\n");
			const joiner = needsNewline ? "\n" : "";
			return `${core}${joiner}${stampLabel}${trailing}`;
		}

		const alreadyHighlighted = core.startsWith("==") && core.endsWith("==");
		const highlighted = alreadyHighlighted ? core : `==${core}==`;
		return `${highlighted} ${stampLabel}${trailing}`;
	}

	private async addTimelineEntry(entry: TimelineEntry) {
		this.data.entries = this.data.entries.filter((existing) => existing.id !== entry.id);
		this.data.entries.push(entry);
		this.data.entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

		await this.savePluginData();
		this.notifySubscribers();
	}

	private notifySubscribers() {
		this.refreshSubscribers.forEach((view) => view.refreshEntries());
	}

	private startAutoScan() {
		this.stopAutoScan();
		void this.scanVaultForTimestamps();
		this.scanIntervalId = this.registerInterval(
			activeWindow.setInterval(() => {
				void this.scanVaultForTimestamps();
			}, 5000)
		);
	}

	private stopAutoScan() {
		this.scanIntervalId = null;
	}

	private async scanVaultForTimestamps(): Promise<void> {
		if (this.isScanning) {
			return;
		}
		this.isScanning = true;

		try {
			const files = this.app.vault.getMarkdownFiles();
			const aggregated: TimelineEntry[] = [];

			for (const file of files) {
				const content = await this.app.vault.cachedRead(file);
				const regex = this.createTimestampRegex();
				let match: RegExpExecArray | null;

				while ((match = regex.exec(content)) !== null) {
					const groups = match.groups;
					if (!groups) {
						continue;
					}

					const iso = groups.iso;
					if (!iso) {
						continue;
					}

					const type: "text" | "image" = groups.image ? "image" : "text";
					const selection = type === "image" ? groups.image ?? "" : groups.text ?? "";
					const snippet = this.createSnippet(selection, type);
					const line = this.countLinesUntil(content, match.index);

					const entry: TimelineEntry = {
						id: this.buildEntryId(file.path, iso, line),
						filePath: file.path,
						fileName: file.basename,
						type,
						timestamp: iso,
						formatted: this.formatTimestamp(iso),
						snippet,
						line
					};

					aggregated.push(entry);
				}
			}

			aggregated.sort((a, b) => {
				const timeOrder = a.timestamp.localeCompare(b.timestamp);
				if (timeOrder !== 0) {
					return timeOrder;
				}
				const pathOrder = a.filePath.localeCompare(b.filePath);
				if (pathOrder !== 0) {
					return pathOrder;
				}
				return a.line - b.line;
			});

			const nextSerialized = JSON.stringify(aggregated);
			const currentSerialized = JSON.stringify(this.data.entries);
			if (nextSerialized === currentSerialized) {
				return;
			}

			this.data.entries = aggregated;
			await this.savePluginData();
			this.notifySubscribers();
		} catch (error) {
			console.error("TimeLineStamp: Failed to scan vault for timestamps.", error);
		} finally {
			this.isScanning = false;
		}
	}

	private createTimestampRegex(): RegExp {
		return new RegExp(TIMESTAMP_CAPTURE_PATTERN, "g");
	}

	private countLinesUntil(source: string, index: number): number {
		let count = 0;
		for (let i = 0; i < index; i++) {
			if (source.charCodeAt(i) === 10) {
				count++;
			}
		}
		return count;
	}

	async toggleTimelineView(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TIMELINE);
		if (leaves.length > 0) {
			leaves.forEach((leaf) => leaf.detach());
			return;
		}
		await this.revealTimelineView();
	}

	async revealTimelineView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_TIMELINE);
		if (existing.length > 0) {
			await workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf: WorkspaceLeaf | null = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);

		if (leaf) {
			await leaf.setViewState({ type: VIEW_TYPE_TIMELINE, active: true });
			await workspace.revealLeaf(leaf);
		}
	}

	private buildEntryId(filePath: string, iso: string, line: number): string {
		return `${filePath}::${line}::${iso}`;
	}

	private formatMoment(stamp: MomentInstance): string {
		return stamp.format(this.data.settings.timestampFormat);
	}

	private formatTimestamp(iso: string): string {
		const parsed = moment(iso);
		return parsed.isValid() ? this.formatMoment(parsed) : iso;
	}

	private promptForTimestamp(initial: MomentInstance): Promise<MomentInstance | null> {
		return new Promise((resolve) => {
			const modal = new TimestampModal(this.app, initial, (value) => resolve(value));
			modal.open();
		});
	}

	private async loadPluginData() {
		const stored = (await this.loadData()) as Partial<TimeLineStampData> | null;
		if (stored) {
			const entries: TimelineEntry[] = Array.isArray(stored.entries) ? stored.entries : [];
			const settings: Partial<TimeLineStampSettings> = stored.settings ?? {};
			this.data = {
				entries,
				settings: { ...DEFAULT_SETTINGS, ...settings }
			};
		} else {
			this.data = createDefaultData();
		}
	}

	private async savePluginData() {
		await this.saveData(this.data);
	}
}

class TimestampModal extends Modal {
	private onSubmit: (value: MomentInstance | null) => void;
	private initial: MomentInstance;
	private input?: HTMLInputElement;

	constructor(app: App, initial: MomentInstance, onSubmit: (value: MomentInstance | null) => void) {
		super(app);
		this.initial = initial.clone();
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		new Setting(contentEl).setName("Select timestamp").setHeading();

		const form = contentEl.createEl("form", { cls: "timeline-stamp-modal" });
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			this.submit();
		});

		const label = form.createEl("label", { text: "Date & time" });
		label.addClass("timeline-stamp-modal__label");

		this.input = form.createEl("input", {
			type: "datetime-local",
			value: this.initial.format("YYYY-MM-DD[T]HH:mm")
		});
		this.input.addClass("timeline-stamp-modal__input");

		const actions = form.createDiv("timeline-stamp-modal__actions");

		const cancelButton = actions.createEl("button", {
			type: "button",
			text: "Cancel"
		});
		cancelButton.addEventListener("click", () => {
			this.onSubmit(null);
			this.close();
		});

		const saveButton = actions.createEl("button", {
			type: "submit",
			text: "Apply"
		});
		saveButton.addClass("mod-cta");

		this.input.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit() {
		if (!this.input) {
			this.onSubmit(null);
			this.close();
			return;
		}

		const value = this.input.value;
		const parsed = moment(value, "YYYY-MM-DDTHH:mm", true);
		if (!parsed.isValid()) {
			new Notice("Enter a valid date and time.");
			return;
		}

		this.onSubmit(parsed);
		this.close();
	}
}

class TimeLineStampSettingTab extends PluginSettingTab {
	private plugin: TimeLineStampPlugin;

	constructor(app: App, plugin: TimeLineStampPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Timestamp format")
			.setDesc("Moment.js format string used when stamping selections.")
			.addText((text) => {
				text
					.setValue(this.plugin.settings.timestampFormat)
					.onChange(async (value) => {
						const fallback = value.trim() === "" ? DEFAULT_SETTINGS.timestampFormat : value;
						await this.plugin.updateSettings({ timestampFormat: fallback });
					});
			});

		new Setting(containerEl)
			.setName("Auto-open timeline after stamping")
			.setDesc("Open the timeline tab when a new timestamp is added.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoOpenTimeline);
				toggle.onChange(async (value) => {
					await this.plugin.updateSettings({ autoOpenTimeline: value });
				});
			});
	}
}

class TimelineView extends ItemView implements TimelineRefreshable {
	private plugin: TimeLineStampPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: TimeLineStampPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_TIMELINE;
	}

	getDisplayText(): string {
		return "Timeline";
	}

	getIcon(): string {
		return "clock";
	}

	onOpen(): Promise<void> {
		this.plugin.registerTimelineView(this);
		this.contentEl.addClass("timeline-stamp-view");
		this.render();
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.plugin.unregisterTimelineView(this);
		this.contentEl.empty();
		return Promise.resolve();
	}

	refreshEntries(): void {
		this.render();
	}

	private render() {
		const entries = this.plugin.getEntries();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("timeline-stamp-view");

		if (entries.length === 0) {
			const emptyEl = contentEl.createEl("p", {
				text: "No timestamps yet. Highlight text or images and run a timestamp command."
			});
			emptyEl.addClass("timeline-stamp-view__empty");
			return;
		}

		const listEl = contentEl.createDiv();
		listEl.addClass("timeline-stamp-view__list");

		for (const entry of entries) {
			const itemEl = listEl.createDiv();
			itemEl.addClass("timeline-stamp-view__item");
			itemEl.tabIndex = 0;

			itemEl.addEventListener("click", () => {
				this.openEntry(entry).catch((error) => console.error(error));
			});

			itemEl.addEventListener("keydown", (event: KeyboardEvent) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					this.openEntry(entry).catch((error) => console.error(error));
				}
			});

			const timeEl = itemEl.createDiv();
			timeEl.addClass("timeline-stamp-view__time");
			timeEl.createSpan({
				text: entry.formatted,
				cls: "timeline-stamp-view__time-primary"
			});
			timeEl.createSpan({
				text: moment(entry.timestamp).fromNow(),
				cls: "timeline-stamp-view__time-relative"
			});

			const infoEl = itemEl.createDiv();
			infoEl.addClass("timeline-stamp-view__info");
			infoEl.createSpan({
				text: entry.type === "image" ? "Image" : "Text",
				cls: "timeline-stamp-view__badge"
			});
			infoEl.createSpan({
				text: entry.snippet,
				cls: "timeline-stamp-view__snippet"
			});

			const metaEl = itemEl.createDiv();
			metaEl.addClass("timeline-stamp-view__meta");
			metaEl.setText(`${entry.fileName}:${entry.line + 1}`);
		}
	}

	private async openEntry(entry: TimelineEntry): Promise<void> {
		const abstract = this.app.vault.getAbstractFileByPath(entry.filePath);
		if (!(abstract instanceof TFile)) {
			new Notice("Original file no longer exists.");
			return;
		}

		await this.app.workspace.openLinkText(entry.filePath, "", false);
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			return;
		}

		const editor = view.editor;
		const safeLine = Math.max(0, Math.min(entry.line, editor.lineCount() - 1));
		const from = { line: safeLine, ch: 0 };
		const to = { line: safeLine, ch: editor.getLine(safeLine)?.length ?? 0 };
		editor.setCursor(from);
		editor.scrollIntoView({ from, to }, true);
	}
}
