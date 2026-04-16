import { App, FileView, ItemView, Modal, Plugin, PluginSettingTab, Setting, TFile, TFolder, WorkspaceLeaf } from 'obsidian';

// --- Types ---

interface Keystroke {
	ms: number;
	char: string;
	first: boolean;
}

interface AnkySettings {
	sessionFolder: string;
}

const DEFAULT_SETTINGS: AnkySettings = {
	sessionFolder: 'ankys',
};

// --- Utility Functions ---

function buildAnkyString(buffer: Keystroke[]): string {
	return buffer.map(k => `${k.ms} ${k.char}`).join('\n');
}

async function computeHash(content: string): Promise<string> {
	const bytes = new TextEncoder().encode(content);
	const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(hashBuffer))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
}

function reconstructText(buffer: Keystroke[]): string {
	return buffer.map(k => (k.char === 'SPACE' ? ' ' : k.char)).join('');
}

function computeFlowScore(buffer: Keystroke[], totalDurationMs: number): number {
	const deltas = buffer.filter(k => !k.first).map(k => k.ms);
	if (deltas.length < 2) return 0;

	const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
	const variance =
		deltas.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / deltas.length;
	const stddev = Math.sqrt(variance);
	const rhythm = Math.max(0, Math.min(1, 1 - stddev / mean));

	const words = reconstructText(buffer).trim().split(/\s+/).length;
	const durationMinutes = totalDurationMs / 60000;
	const velocity = Math.min(1, (words / durationMinutes) / 60);

	const longPauses = deltas.filter(d => d > 3000).length;
	const attention = Math.max(0, 1 - longPauses * 0.05);

	const duration = Math.min(1, totalDurationMs / 480000);

	return Math.round(
		(rhythm * 0.3 + velocity * 0.25 + attention * 0.25 + duration * 0.2) * 100
	);
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// --- Confirm Modal ---

class AnkyConfirmModal extends Modal {
	private message: string;
	private resolved = false;
	private resolvePromise: ((value: boolean) => void) | null = null;

	constructor(app: App, message: string) {
		super(app);
		this.message = message;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		modalEl.addClass('anky-confirm-modal');
		contentEl.addClass('anky-confirm-content');
		contentEl.empty();

		const msg = contentEl.createDiv({ cls: 'anky-confirm-message' });
		msg.textContent = this.message;

		const buttons = contentEl.createDiv({ cls: 'anky-confirm-buttons' });

		const cancelBtn = buttons.createEl('button', { cls: 'anky-btn-cancel' });
		cancelBtn.textContent = 'Cancel';
		cancelBtn.addEventListener('click', () => {
			this.resolved = true;
			if (this.resolvePromise) this.resolvePromise(false);
			this.close();
		});

		const confirmBtn = buttons.createEl('button', { cls: 'anky-btn-danger' });
		confirmBtn.textContent = 'Delete';
		confirmBtn.addEventListener('click', () => {
			this.resolved = true;
			if (this.resolvePromise) this.resolvePromise(true);
			this.close();
		});
	}

	onClose() {
		if (!this.resolved && this.resolvePromise) {
			this.resolvePromise(false);
		}
		this.contentEl.empty();
	}

	waitForResult(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
		});
	}
}

// --- Writing Modal ---

class AnkyWritingModal extends Modal {
	private plugin: AnkyPlugin;
	private keystrokeBuffer: Keystroke[] = [];
	private firstKeystrokeEpochMs: number = 0;
	private lastKeystrokeTime: number = 0;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private sessionActive: boolean = false;
	private writingArea: HTMLDivElement | null = null;
	private placeholderEl: HTMLDivElement | null = null;
	private idleBarFill: HTMLDivElement | null = null;
	private idleBarTrack: HTMLDivElement | null = null;
	private progressBarFill: HTMLDivElement | null = null;
	private timerEl: HTMLDivElement | null = null;
	private animFrameId: number | null = null;
	private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

	constructor(app: App, plugin: AnkyPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl, modalEl, containerEl } = this;

		modalEl.addClass('anky-writing-modal');
		containerEl.addClass('anky-writing-container');

		const closeButton = modalEl.querySelector('.modal-close-button');
		if (closeButton) (closeButton as HTMLElement).addClass('anky-close-button-hidden');

		contentEl.addClass('anky-writing-content');
		contentEl.empty();

		// TOP: Idle bar (8-second countdown, hidden until 3s of silence)
		this.idleBarTrack = contentEl.createDiv({ cls: 'anky-idle-bar-track' });
		this.idleBarFill = this.idleBarTrack.createDiv({ cls: 'anky-idle-bar-fill' });

		// MIDDLE: Writing area with placeholder
		const writingWrapper = contentEl.createDiv({ cls: 'anky-writing-wrapper' });

		this.placeholderEl = writingWrapper.createDiv({ cls: 'anky-placeholder' });
		this.placeholderEl.textContent = 'What is alive in you right now?';

		this.writingArea = writingWrapper.createDiv({ cls: 'anky-writing-area' });
		this.writingArea.setAttribute('contenteditable', 'true');

		// BOTTOM: Progress bar (8-minute, rainbow gradient)
		const progressBarTrack = contentEl.createDiv({ cls: 'anky-progress-bar-track' });
		this.progressBarFill = progressBarTrack.createDiv({ cls: 'anky-progress-bar-fill' });

		// Timer below progress bar
		this.timerEl = contentEl.createDiv({ cls: 'anky-timer' });
		this.timerEl.textContent = '8:00';

		// Focus
		setTimeout(() => {
			if (this.writingArea) this.writingArea.focus();
		}, 50);

		// Keydown
		this.sessionActive = true;
		this.keydownHandler = (e: KeyboardEvent) => { this.handleKeydown(e); };
		this.writingArea.addEventListener('keydown', this.keydownHandler);

		// Block paste, drop, non-insertText input
		this.writingArea.addEventListener('paste', (e) => e.preventDefault());
		this.writingArea.addEventListener('drop', (e) => e.preventDefault());
		this.writingArea.addEventListener('beforeinput', (e) => {
			if (e.inputType !== 'insertText') {
				e.preventDefault();
			}
		});
	}

	private startAnimationLoop() {
		const tick = () => {
			if (!this.sessionActive) return;

			const now = Date.now();
			const elapsed = now - this.firstKeystrokeEpochMs;
			const sinceLast = now - this.lastKeystrokeTime;

			// Update idle bar: depletes from right to left over 8 seconds
			if (this.idleBarFill) {
				const remaining = Math.max(0, 1 - sinceLast / 8000);
				this.idleBarFill.setCssProps({ '--anky-idle-width': `${remaining * 100}%` });
				this.idleBarFill.style.width = `${remaining * 100}%`;
			}

			// Show idle bar after 3 seconds of silence
			if (this.idleBarTrack) {
				if (sinceLast >= 3000) {
					this.idleBarTrack.addClass('anky-idle-bar-track--visible');
				} else {
					this.idleBarTrack.removeClass('anky-idle-bar-track--visible');
				}
			}

			// Update progress bar: grows over 8 minutes
			if (this.progressBarFill) {
				const progress = Math.min(1, elapsed / 480000);
				this.progressBarFill.style.width = `${progress * 100}%`;
			}

			// Update timer: countdown from 8:00 to 0:00, then count up
			if (this.timerEl) {
				const remainingMs = 480000 - elapsed;
				if (remainingMs >= 0) {
					const totalSec = Math.ceil(remainingMs / 1000);
					const m = Math.floor(totalSec / 60);
					const s = totalSec % 60;
					this.timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
				} else {
					const overMs = elapsed - 480000;
					const totalSec = Math.floor(overMs / 1000);
					const m = 8 + Math.floor(totalSec / 60);
					const s = totalSec % 60;
					this.timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
				}
			}

			this.animFrameId = requestAnimationFrame(tick);
		};
		this.animFrameId = requestAnimationFrame(tick);
	}

	private handleKeydown(e: KeyboardEvent) {
		if (!this.sessionActive) return;

		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
			return;
		}

		const banned = [
			'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight',
			'ArrowUp', 'ArrowDown', 'Enter', 'Tab',
		];

		if (banned.includes(e.key)) {
			e.preventDefault();
			return;
		}

		if (e.ctrlKey || e.metaKey || e.altKey) {
			e.preventDefault();
			return;
		}

		if (e.key.length !== 1) {
			e.preventDefault();
			return;
		}

		e.preventDefault();

		const char = e.key === ' ' ? 'SPACE' : e.key;
		const displayChar = e.key;
		const now = Date.now();

		if (this.keystrokeBuffer.length === 0) {
			this.firstKeystrokeEpochMs = now;
			this.lastKeystrokeTime = now;
			this.keystrokeBuffer.push({ ms: now, char, first: true });

			// Remove placeholder on first keystroke
			if (this.placeholderEl) {
				this.placeholderEl.addClass('anky-placeholder--hidden');
			}

			// Start animation loop
			this.startAnimationLoop();
		} else {
			const delta = now - this.lastKeystrokeTime;
			this.lastKeystrokeTime = now;
			this.keystrokeBuffer.push({ ms: delta, char, first: false });
		}

		// Append character to writing area
		if (this.writingArea) {
			this.writingArea.textContent += displayChar;
			this.writingArea.scrollTop = this.writingArea.scrollHeight;
		}

		// Reset idle timer
		this.resetIdleTimer();
	}

	private resetIdleTimer() {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}

		// End session at 8 seconds of silence
		this.idleTimer = setTimeout(() => {
			void this.endSession();
		}, 8000);
	}

	private async endSession() {
		if (!this.sessionActive) return;
		this.sessionActive = false;

		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.animFrameId) cancelAnimationFrame(this.animFrameId);

		if (this.keystrokeBuffer.length < 10) {
			this.close();
			return;
		}

		const ankyString = buildAnkyString(this.keystrokeBuffer);
		const hash = await computeHash(ankyString);

		const verifyHash = await computeHash(ankyString);
		if (verifyHash !== hash) {
			console.error('Anky: hash sanity check failed');
			this.close();
			return;
		}

		try {
			const filePath = await this.saveSession(ankyString, hash, this.firstKeystrokeEpochMs);

			const written = await this.app.vault.adapter.read(filePath);
			const writtenHash = await computeHash(written);
			if (writtenHash !== hash) {
				throw new Error('hash mismatch after write');
			}

			const totalDurationMs = this.lastKeystrokeTime - this.firstKeystrokeEpochMs;
			const text = reconstructText(this.keystrokeBuffer).trim();
			const wordCount = text.length === 0 ? 0 : text.split(/\s+/).length;
			const flowScore = computeFlowScore(this.keystrokeBuffer, totalDurationMs);

			this.close();

			const completionModal = new AnkyCompletionModal(
				this.app,
				hash,
				wordCount,
				totalDurationMs,
				flowScore,
				filePath
			);
			completionModal.open();
		} catch (err) {
			console.error('Anky: failed to save session', err);
			this.close();
		}
	}

	private async saveSession(ankyString: string, hash: string, epochMs: number): Promise<string> {
		const folder = this.plugin.settings.sessionFolder;
		const date = new Date(epochMs);
		const yyyy = date.getFullYear().toString();
		const mm = (date.getMonth() + 1).toString().padStart(2, '0');
		const dd = date.getDate().toString().padStart(2, '0');

		const folderPath = `${folder}/${yyyy}/${mm}/${dd}`;
		const filePath = `${folderPath}/${hash}.anky`;

		if (!(await this.app.vault.adapter.exists(folder)))
			await this.app.vault.createFolder(folder);
		if (!(await this.app.vault.adapter.exists(`${folder}/${yyyy}`)))
			await this.app.vault.createFolder(`${folder}/${yyyy}`);
		if (!(await this.app.vault.adapter.exists(`${folder}/${yyyy}/${mm}`)))
			await this.app.vault.createFolder(`${folder}/${yyyy}/${mm}`);
		if (!(await this.app.vault.adapter.exists(folderPath)))
			await this.app.vault.createFolder(folderPath);

		await this.app.vault.adapter.write(filePath, ankyString);
		return filePath;
	}

	onClose() {
		this.sessionActive = false;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
		this.contentEl.empty();
	}
}

// --- Completion Modal ---

class AnkyCompletionModal extends Modal {
	private hash: string;
	private wordCount: number;
	private durationMs: number;
	private flowScore: number;
	private filePath: string;
	private autoCloseTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		app: App,
		hash: string,
		wordCount: number,
		durationMs: number,
		flowScore: number,
		filePath: string
	) {
		super(app);
		this.hash = hash;
		this.wordCount = wordCount;
		this.durationMs = durationMs;
		this.flowScore = flowScore;
		this.filePath = filePath;
	}

	onOpen() {
		const { contentEl, modalEl, containerEl } = this;

		modalEl.addClass('anky-completion-modal');
		containerEl.addClass('anky-writing-container');

		const closeButton = modalEl.querySelector('.modal-close-button');
		if (closeButton) (closeButton as HTMLElement).addClass('anky-close-button-hidden');

		contentEl.addClass('anky-completion-content');
		contentEl.empty();

		// Session complete label
		const label = contentEl.createDiv({ cls: 'anky-completion-label' });
		label.textContent = 'Session complete';

		// Word count
		const wordsEl = contentEl.createDiv({ cls: 'anky-completion-word-count' });
		wordsEl.textContent = this.wordCount.toString();

		const wordsLabel = contentEl.createDiv({ cls: 'anky-completion-words-label' });
		wordsLabel.textContent = 'Words';

		// Duration
		const durationEl = contentEl.createDiv({ cls: 'anky-completion-duration' });
		durationEl.textContent = formatDuration(this.durationMs);

		const durationLabel = contentEl.createDiv({ cls: 'anky-completion-duration-label' });
		durationLabel.textContent = 'Session duration';

		// Flow score
		const flowEl = contentEl.createDiv({ cls: 'anky-completion-flow' });
		flowEl.textContent = `${this.flowScore}%`;

		const flowLabel = contentEl.createDiv({ cls: 'anky-completion-flow-label' });
		flowLabel.textContent = 'Flow score';

		// Buttons row
		const buttonsRow = contentEl.createDiv({ cls: 'anky-completion-buttons' });

		// Open button
		const button = buttonsRow.createEl('button', { cls: 'anky-btn-primary' });
		button.textContent = 'Open in vault';
		button.addEventListener('click', () => {
			this.close();
			void this.app.workspace.openLinkText(this.filePath, '', false);
		});

		// Info button
		const infoBtn = buttonsRow.createEl('button', { cls: 'anky-btn-info' });
		infoBtn.textContent = '\u24D8';
		infoBtn.addEventListener('click', () => {
			new AnkyInfoModal(this.app).open();
		});

		// Auto-close after 30 seconds
		this.autoCloseTimer = setTimeout(() => {
			this.close();
		}, 30000);
	}

	onClose() {
		if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
		this.contentEl.empty();
	}
}

// --- File View ---

const ANKY_VIEW_TYPE = 'anky-view';
const ANKY_MAP_VIEW_TYPE = 'anky-map-view';

// --- Info Modal ---

class AnkyInfoModal extends Modal {
	onOpen() {
		const { contentEl, modalEl } = this;

		modalEl.addClass('anky-info-modal');
		contentEl.addClass('anky-info-content');
		contentEl.empty();

		const title = contentEl.createDiv({ cls: 'anky-info-title' });
		title.textContent = 'Anky';

		const desc = contentEl.createDiv({ cls: 'anky-info-desc' });
		desc.textContent = 'To unlock the full Anky experience \u2014 reflections, insights, and more \u2014 get the mobile app.';

		const buttonContainer = contentEl.createDiv({ cls: 'anky-info-buttons' });

		const copyBtn = buttonContainer.createEl('button', { cls: 'anky-btn anky-btn--purple' });
		copyBtn.textContent = 'Copy TestFlight link';
		copyBtn.addEventListener('click', () => {
			void navigator.clipboard.writeText('https://testflight.apple.com/join/WcRYyCm5').then(() => {
				copyBtn.textContent = 'Copied!';
				setTimeout(() => { copyBtn.textContent = 'Copy TestFlight link'; }, 2000);
			});
		});

		const contactBtn = buttonContainer.createEl('a', { cls: 'anky-btn anky-btn--blue' });
		contactBtn.href = 'https://x.com/jpfraneto';
		contactBtn.textContent = 'Contact the dev';
	}

	onClose() {
		this.contentEl.empty();
	}
}

class AnkyFileView extends FileView {
	private plugin: AnkyPlugin | null = null;
	private fileKeyHandler: ((e: KeyboardEvent) => void) | null = null;

	getViewType(): string {
		return ANKY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename.slice(0, 8) + '...' || 'Anky';
	}

	setPlugin(plugin: AnkyPlugin) {
		this.plugin = plugin;
	}

	async onLoadFile(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		this.renderSession(content, file.basename);
		this.fileKeyHandler = (e: KeyboardEvent) => { this.handleFileKey(e); };
		this.contentEl.tabIndex = 0;
		this.contentEl.addEventListener('keydown', this.fileKeyHandler);
		this.contentEl.focus();
	}

	private handleFileKey(e: KeyboardEvent) {
		if (e.key === 'Backspace' || e.key === 'Delete') {
			e.preventDefault();
			window.history.back();
			return;
		}

		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			e.preventDefault();
			void this.navigateSibling(e.key === 'ArrowRight' ? 1 : -1);
			return;
		}
	}

	private async navigateSibling(direction: number) {
		if (!this.file || !this.plugin) return;
		const folder = this.plugin.settings.sessionFolder;
		const root = this.app.vault.getAbstractFileByPath(folder);
		if (!root || !(root instanceof TFolder)) return;

		const allFiles: TFile[] = [];
		const collect = (f: TFolder) => {
			for (const child of f.children) {
				if (child instanceof TFile && child.extension === 'anky') {
					allFiles.push(child);
				} else if (child instanceof TFolder) {
					collect(child);
				}
			}
		};
		collect(root);

		allFiles.sort((a, b) => a.path.localeCompare(b.path));
		const currentIdx = allFiles.findIndex(f => f.path === this.file?.path);
		if (currentIdx < 0) return;

		const nextIdx = currentIdx + direction;
		if (nextIdx < 0 || nextIdx >= allFiles.length) return;

		await this.app.workspace.openLinkText(allFiles[nextIdx].path, '', false);
	}

	async onUnloadFile(file: TFile): Promise<void> {
		await super.onUnloadFile(file);
		if (this.fileKeyHandler) {
			this.contentEl.removeEventListener('keydown', this.fileKeyHandler);
		}
		this.contentEl.empty();
	}

	private renderSession(content: string, hash: string) {
		this.contentEl.empty();
		this.contentEl.addClass('anky-file-view');

		const lines = content.split('\n').filter(l => l.trim());
		if (lines.length === 0) return;

		const records = lines.map((line, i) => {
			const sp = line.indexOf(' ');
			const ms = parseInt(line.slice(0, sp));
			const char = line.slice(sp + 1);
			return { ms, char, first: i === 0 };
		});

		const text = records
			.map(r => (r.char === 'SPACE' ? ' ' : r.char))
			.join('');

		const epochMs = records[0].ms;
		const deltas = records.slice(1).map(r => r.ms);
		const totalMs = deltas.reduce((a, b) => a + b, 0);
		const words = text.trim().split(/\s+/).filter(w => w).length;
		const date = new Date(epochMs);
		const duration = `${Math.floor(totalMs / 60000)}:${Math.floor((totalMs % 60000) / 1000)
			.toString()
			.padStart(2, '0')}`;

		let flowScore = 0;
		if (deltas.length >= 2) {
			const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
			const std = Math.sqrt(
				deltas.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / deltas.length
			);
			const rhythm = Math.max(0, Math.min(1, 1 - std / mean));
			const velocity = Math.min(1, words / (totalMs / 60000) / 60);
			const attention = Math.max(0, 1 - deltas.filter(d => d > 3000).length * 0.05);
			const dur = Math.min(1, totalMs / 480000);
			flowScore = Math.round(
				(rhythm * 0.3 + velocity * 0.25 + attention * 0.25 + dur * 0.2) * 100
			);
		}

		// Top bar: map button + stats
		const topBar = this.contentEl.createDiv({ cls: 'anky-file-top-bar' });

		const leftButtons = topBar.createDiv({ cls: 'anky-file-left-buttons' });

		const mapBtn = leftButtons.createEl('button', { cls: 'anky-btn-outline' });
		mapBtn.textContent = 'Map';
		mapBtn.addEventListener('click', () => {
			void this.openMapView();
		});

		const statsRow = leftButtons.createDiv({ cls: 'anky-stats-row' });

		const rightButtons = topBar.createDiv({ cls: 'anky-file-right-buttons' });

		const infoBtn = rightButtons.createEl('button', { cls: 'anky-btn-info-small' });
		infoBtn.textContent = '\u24D8';
		infoBtn.addEventListener('click', () => {
			new AnkyInfoModal(this.app).open();
		});

		const deleteBtn = rightButtons.createEl('button', { cls: 'anky-btn-delete' });
		deleteBtn.textContent = 'Delete session';
		deleteBtn.addEventListener('click', () => {
			const file = this.file;
			if (!file) return;
			const modal = new AnkyConfirmModal(this.app, 'Delete this session?');
			modal.open();
			void modal.waitForResult().then((confirmed) => {
				if (!confirmed) return;
				void this.app.fileManager.trashFile(file).then(() => {
					window.history.back();
				});
			});
		});

		const addStat = (value: string, label: string) => {
			const s = statsRow.createDiv({ cls: 'anky-stat' });
			const n = s.createDiv({ cls: 'anky-stat-value' });
			n.textContent = value;
			const l = s.createDiv({ cls: 'anky-stat-label' });
			l.textContent = label;
		};

		addStat(
			date.toLocaleDateString('en', { month: 'short', day: 'numeric' }),
			'Date'
		);
		addStat(duration, 'Duration');
		addStat(String(words), 'Words');
		addStat(flowScore + '%', 'Flow');

		// Text content
		const textPanel = this.contentEl.createDiv({ cls: 'anky-text-panel' });
		const body = textPanel.createDiv({ cls: 'anky-text-body' });
		body.textContent = text;
	}

	private async openMapView() {
		const existing = this.app.workspace.getLeavesOfType(ANKY_MAP_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: ANKY_MAP_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}
}

// --- Map View ---

interface SessionSummary {
	path: string;
	hash: string;
	date: Date;
	durationMs: number;
	words: number;
	isAnky: boolean; // true if duration >= 8 minutes
	text: string;
}

class AnkyMapView extends ItemView {
	private plugin: AnkyPlugin;
	private sessions: SessionSummary[] = [];
	private cells: HTMLDivElement[] = [];
	private selectedIndex: number = -1;
	private infoEl: HTMLDivElement | null = null;
	private previewEl: HTMLDivElement | null = null;
	private keyHandler: ((e: KeyboardEvent) => void) | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: AnkyPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return ANKY_MAP_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Anky map';
	}

	getIcon(): string {
		return 'map';
	}

	async onOpen() {
		await this.renderMap();
		this.keyHandler = (e: KeyboardEvent) => { this.handleKey(e); };
		this.contentEl.tabIndex = 0;
		this.contentEl.addEventListener('keydown', this.keyHandler);
		this.contentEl.focus();
	}

	onClose() {
		if (this.keyHandler) {
			this.contentEl.removeEventListener('keydown', this.keyHandler);
		}
		this.contentEl.empty();
	}

	private handleKey(e: KeyboardEvent) {
		if (e.key === 'Backspace' || e.key === 'Delete') {
			e.preventDefault();
			window.history.back();
			return;
		}

		if (this.sessions.length === 0) return;

		if (e.key === ' ') {
			e.preventDefault();
			if (this.selectedIndex >= 0 && this.selectedIndex < this.sessions.length) {
				void this.app.workspace.openLinkText(this.sessions[this.selectedIndex].path, '', false);
			}
			return;
		}

		if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
		e.preventDefault();

		// Figure out how many cells fit per row
		const gridWidth = this.cells[0]?.parentElement?.clientWidth ?? 0;
		const cellWidth = 32 + 6; // cell width + gap
		const cols = Math.max(1, Math.floor((gridWidth + 6) / cellWidth));

		let next = this.selectedIndex;

		if (e.key === 'ArrowRight') {
			next = Math.min(this.cells.length - 1, next + 1);
		} else if (e.key === 'ArrowLeft') {
			next = Math.max(0, next - 1);
		} else if (e.key === 'ArrowDown') {
			next = Math.min(this.cells.length - 1, next + cols);
		} else if (e.key === 'ArrowUp') {
			next = Math.max(0, next - cols);
		}

		if (next < 0) next = 0;
		this.selectCell(next);
	}

	private selectCell(index: number) {
		// Deselect old
		if (this.selectedIndex >= 0 && this.selectedIndex < this.cells.length) {
			const old = this.cells[this.selectedIndex];
			old.removeClass('anky-map-cell--selected');
			old.addClass('anky-map-cell--deselected');
		}

		this.selectedIndex = index;

		// Select new
		const cell = this.cells[index];
		cell.removeClass('anky-map-cell--deselected');
		cell.addClass('anky-map-cell--selected');
		cell.scrollIntoView({ block: 'nearest' });

		// Update info panel + preview
		this.updateInfo(this.sessions[index]);
		this.updatePreview(this.sessions[index]);
	}

	private updateInfo(session: SessionSummary) {
		if (!this.infoEl) return;
		this.infoEl.empty();

		const durationMin = Math.floor(session.durationMs / 60000);
		const durationSec = Math.floor((session.durationMs % 60000) / 1000);
		const dateStr = session.date.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
		const dur = `${durationMin}:${durationSec.toString().padStart(2, '0')}`;

		const typeLabel = this.infoEl.createSpan({ cls: session.isAnky ? 'anky-map-info-anky-label' : 'anky-map-info-session-label' });
		typeLabel.textContent = session.isAnky ? 'Anky' : 'Session';

		this.infoEl.appendText(` \u00B7 ${dateStr} \u00B7 ${dur} \u00B7 ${session.words} Words  `);

		const openHint = this.infoEl.createSpan({ cls: 'anky-map-info-open-hint' });
		openHint.textContent = 'Space to open';
	}

	private updatePreview(session: SessionSummary) {
		if (!this.previewEl) return;
		this.previewEl.empty();

		const dateStr = session.date.toLocaleDateString('en', { month: 'short', day: 'numeric' });
		const durationMin = Math.floor(session.durationMs / 60000);
		const durationSec = Math.floor((session.durationMs % 60000) / 1000);
		const dur = `${durationMin}:${durationSec.toString().padStart(2, '0')}`;

		const header = this.previewEl.createDiv({ cls: 'anky-preview-header' });

		const dateSpan = header.createSpan({ cls: 'anky-preview-date' });
		dateSpan.textContent = dateStr;

		const durSpan = header.createSpan();
		durSpan.textContent = dur;

		const wordsSpan = header.createSpan();
		wordsSpan.textContent = `${session.words} Words`;

		const typeSpan = header.createSpan({ cls: session.isAnky ? 'anky-map-info-anky-label' : '' });
		typeSpan.textContent = session.isAnky ? 'Anky' : 'Session';

		const textEl = this.previewEl.createDiv({ cls: 'anky-preview-text' });
		textEl.textContent = session.text;
	}

	private async renderMap() {
		this.contentEl.empty();
		this.cells = [];
		this.selectedIndex = -1;
		this.contentEl.addClass('anky-map-view');

		const header = this.contentEl.createDiv({ cls: 'anky-map-header' });

		const title = header.createDiv({ cls: 'anky-map-title' });
		title.textContent = 'Anky map';

		// Scan all .anky files
		this.sessions = await this.scanSessions();

		const totalCount = this.sessions.length;
		const ankyCount = this.sessions.filter(s => s.isAnky).length;

		const summaryEl = header.createDiv({ cls: 'anky-map-summary' });

		const totalEl = summaryEl.createDiv();
		const totalNum = totalEl.createSpan({ cls: 'anky-map-summary-total' });
		totalNum.textContent = String(totalCount);
		totalEl.appendText(' Sessions');

		const ankyEl = summaryEl.createDiv();
		const ankyNum = ankyEl.createSpan({ cls: 'anky-map-summary-anky' });
		ankyNum.textContent = String(ankyCount);
		ankyEl.appendText(' Ankys');

		// Main layout: grid left, preview right
		const mainLayout = this.contentEl.createDiv({ cls: 'anky-map-main' });

		// Left side: legend + info + grid
		const leftPanel = mainLayout.createDiv({ cls: 'anky-map-left' });

		// Legend
		const legend = leftPanel.createDiv({ cls: 'anky-map-legend' });

		const addLegendItem = (dotCls: string, label: string) => {
			const item = legend.createDiv({ cls: 'anky-legend-item' });
			item.createDiv({ cls: `anky-legend-dot ${dotCls}` });
			const text = item.createDiv();
			text.textContent = label;
		};

		addLegendItem('anky-legend-dot--anky', 'Anky (8+ min)');
		addLegendItem('anky-legend-dot--session', 'Session (< 8 min)');

		// Info panel
		this.infoEl = leftPanel.createDiv({ cls: 'anky-map-info' });
		const hintSpan = this.infoEl.createSpan({ cls: 'anky-map-info-hint' });
		hintSpan.textContent = 'Arrow keys to navigate, space to open';

		// Grid
		this.sessions.sort((a, b) => a.date.getTime() - b.date.getTime());

		const grid = leftPanel.createDiv({ cls: 'anky-map-grid' });

		for (let i = 0; i < this.sessions.length; i++) {
			const session = this.sessions[i];
			const cellCls = session.isAnky ? 'anky-map-cell anky-map-cell--anky' : 'anky-map-cell anky-map-cell--session';
			const cell = grid.createDiv({ cls: cellCls });

			const idx = i;
			cell.addEventListener('mouseenter', () => {
				this.selectCell(idx);
			});
			cell.addEventListener('mouseleave', () => {
				if (this.selectedIndex === idx) {
					cell.removeClass('anky-map-cell--selected');
					cell.addClass('anky-map-cell--deselected');
				}
			});

			cell.addEventListener('click', () => {
				void this.app.workspace.openLinkText(session.path, '', false);
			});

			this.cells.push(cell);
		}

		if (this.sessions.length === 0) {
			const empty = leftPanel.createDiv({ cls: 'anky-map-empty' });
			empty.textContent = 'No sessions yet. Start writing!';
		}

		// Right side: preview panel
		this.previewEl = mainLayout.createDiv({ cls: 'anky-map-right' });

		const previewHint = this.previewEl.createDiv({ cls: 'anky-map-preview-hint' });
		previewHint.textContent = 'Select a session to preview';
	}

	private async scanSessions(): Promise<SessionSummary[]> {
		const folder = this.plugin.settings.sessionFolder;
		const sessions: SessionSummary[] = [];

		const collectFiles = (f: TFolder) => {
			for (const child of f.children) {
				if (child instanceof TFile && child.extension === 'anky') {
					sessions.push({ path: child.path, hash: child.basename, date: new Date(), durationMs: 0, words: 0, isAnky: false, text: '' });
				} else if (child instanceof TFolder) {
					collectFiles(child);
				}
			}
		};

		const root = this.app.vault.getAbstractFileByPath(folder);
		if (root instanceof TFolder) {
			collectFiles(root);
		}

		// Parse each file for metadata
		for (const session of sessions) {
			try {
				const content = await this.app.vault.adapter.read(session.path);
				const lines = content.split('\n').filter(l => l.trim());
				if (lines.length === 0) continue;

				const records = lines.map((line, i) => {
					const sp = line.indexOf(' ');
					const ms = parseInt(line.slice(0, sp));
					const char = line.slice(sp + 1);
					return { ms, char, first: i === 0 };
				});

				const text = records.map(r => (r.char === 'SPACE' ? ' ' : r.char)).join('');
				const epochMs = records[0].ms;
				const deltas = records.slice(1).map(r => r.ms);
				const totalMs = deltas.reduce((a, b) => a + b, 0);

				session.date = new Date(epochMs);
				session.durationMs = totalMs;
				session.words = text.trim().split(/\s+/).filter(w => w).length;
				session.isAnky = totalMs >= 480000; // 8 minutes
				session.text = text;
			} catch {
				// skip unparseable files
			}
		}

		return sessions;
	}
}

// --- Settings Tab ---

class AnkySettingTab extends PluginSettingTab {
	plugin: AnkyPlugin;

	constructor(app: App, plugin: AnkyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Session folder')
			.setDesc('Folder within your vault where .anky files are saved.')
			.addText(text =>
				text
					.setPlaceholder('ankys')
					.setValue(this.plugin.settings.sessionFolder)
					.onChange((value) => {
						this.plugin.settings.sessionFolder = value || 'ankys';
						void this.plugin.saveSettings();
					})
			);
	}
}

// --- Plugin ---

export default class AnkyPlugin extends Plugin {
	settings: AnkySettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		this.registerView(ANKY_VIEW_TYPE, (leaf: WorkspaceLeaf) => {
			const view = new AnkyFileView(leaf);
			view.setPlugin(this);
			return view;
		});
		this.registerView(ANKY_MAP_VIEW_TYPE, (leaf: WorkspaceLeaf) => new AnkyMapView(leaf, this));
		this.registerExtensions(['anky'], ANKY_VIEW_TYPE);

		this.addCommand({
			id: 'start-session',
			name: 'Start writing session',
			callback: () => {
				new AnkyWritingModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'open-map',
			name: 'Open map',
			callback: () => {
				const existing = this.app.workspace.getLeavesOfType(ANKY_MAP_VIEW_TYPE);
				if (existing.length > 0) {
					this.app.workspace.revealLeaf(existing[0]);
					return;
				}
				const leaf = this.app.workspace.getLeaf(true);
				void leaf.setViewState({ type: ANKY_MAP_VIEW_TYPE, active: true }).then(() => {
					this.app.workspace.revealLeaf(leaf);
				});
			},
		});

		this.addSettingTab(new AnkySettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
