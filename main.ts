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

// --- Writing Modal ---

class AnkyWritingModal extends Modal {
	private plugin: AnkyPlugin;
	private keystrokeBuffer: Keystroke[] = [];
	private firstKeystrokeEpochMs: number = 0;
	private lastKeystrokeTime: number = 0;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private idleShowTimer: ReturnType<typeof setTimeout> | null = null;
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

		modalEl.style.cssText = `
			position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
			max-width: 100vw; max-height: 100vh; margin: 0; padding: 0;
			border: none; border-radius: 0; background: #06040f;
			display: flex; flex-direction: column; z-index: 9999;
		`;

		containerEl.style.cssText = `
			position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
			background: rgba(0,0,0,0.95); z-index: 9998;
		`;

		const closeButton = modalEl.querySelector('.modal-close-button');
		if (closeButton) (closeButton as HTMLElement).style.display = 'none';

		contentEl.style.cssText = `
			display: flex; flex-direction: column; flex: 1;
			padding: 0; margin: 0; overflow: hidden;
		`;

		contentEl.empty();

		// TOP: Idle bar (8-second countdown, hidden until 3s of silence)
		this.idleBarTrack = contentEl.createDiv();
		this.idleBarTrack.style.cssText = `
			width: 100%; height: 3px; background: #1a1030;
			flex-shrink: 0; opacity: 0; transition: opacity 0.3s ease;
			margin-top: 28px;
		`;
		this.idleBarFill = this.idleBarTrack.createDiv();
		this.idleBarFill.style.cssText = `
			width: 100%; height: 100%; background: #ea580c;
			transition: width 0.1s linear;
		`;

		// MIDDLE: Writing area with placeholder
		const writingWrapper = contentEl.createDiv();
		writingWrapper.style.cssText = `
			flex: 1; position: relative; overflow: hidden;
		`;

		this.placeholderEl = writingWrapper.createDiv();
		this.placeholderEl.style.cssText = `
			position: absolute; top: 24px; left: 32px; right: 32px;
			font-family: Georgia, serif; font-size: 17px; line-height: 1.75;
			color: rgba(255,255,255,0.25); pointer-events: none;
			user-select: none;
		`;
		this.placeholderEl.textContent = 'what is alive in you right now?';

		this.writingArea = writingWrapper.createDiv();
		this.writingArea.setAttribute('contenteditable', 'true');
		this.writingArea.style.cssText = `
			position: absolute; top: 0; left: 0; right: 0; bottom: 0;
			padding: 24px 32px; background: transparent;
			font-family: Georgia, serif; font-size: 17px; line-height: 1.75;
			color: #e8e2f8; caret-color: transparent; outline: none;
			border: none; overflow-y: auto; white-space: pre-wrap;
			word-wrap: break-word;
		`;

		// BOTTOM: Progress bar (8-minute, rainbow gradient)
		const progressBarTrack = contentEl.createDiv();
		progressBarTrack.style.cssText = `
			width: 100%; height: 4px; background: #1a1030;
			flex-shrink: 0;
		`;
		this.progressBarFill = progressBarTrack.createDiv();
		this.progressBarFill.style.cssText = `
			width: 0%; height: 100%;
			background: linear-gradient(to right, #ef4444, #f97316, #eab308, #22c55e, #3b82f6, #6366f1, #8b5cf6, #ffffff);
			transition: width 0.5s linear;
		`;

		// Timer below progress bar
		this.timerEl = contentEl.createDiv();
		this.timerEl.style.cssText = `
			text-align: center; padding: 8px 16px 12px 16px;
			font-size: 13px; color: rgba(255,255,255,0.3);
			font-family: monospace; flex-shrink: 0;
		`;
		this.timerEl.textContent = '8:00';

		// Focus
		setTimeout(() => {
			if (this.writingArea) this.writingArea.focus();
		}, 50);

		// Keydown
		this.sessionActive = true;
		this.keydownHandler = (e: KeyboardEvent) => this.handleKeydown(e);
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
				this.idleBarFill.style.width = `${remaining * 100}%`;
			}

			// Show idle bar after 3 seconds of silence
			if (this.idleBarTrack) {
				this.idleBarTrack.style.opacity = sinceLast >= 3000 ? '1' : '0';
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
				this.placeholderEl.style.display = 'none';
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
			this.endSession();
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

		modalEl.style.cssText = `
			position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
			max-width: 100vw; max-height: 100vh; margin: 0; padding: 0;
			border: none; border-radius: 0; background: #06040f;
			display: flex; flex-direction: column; align-items: center;
			justify-content: center; z-index: 9999;
		`;

		containerEl.style.cssText = `
			position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
			background: rgba(0,0,0,0.95); z-index: 9998;
		`;

		const closeButton = modalEl.querySelector('.modal-close-button');
		if (closeButton) (closeButton as HTMLElement).style.display = 'none';

		contentEl.style.cssText = `
			display: flex; flex-direction: column; align-items: center;
			justify-content: center; flex: 1; text-align: center;
			font-family: Georgia, serif; padding: 32px;
		`;

		contentEl.empty();

		// Session complete label
		const label = contentEl.createDiv();
		label.style.cssText = `
			font-size: 14px; color: rgba(255,255,255,0.3);
			letter-spacing: 0.15em; text-transform: uppercase;
			margin-bottom: 32px;
		`;
		label.textContent = 'session complete';

		// Word count
		const wordsEl = contentEl.createDiv();
		wordsEl.style.cssText = `
			font-size: 48px; font-weight: 200; color: #fff;
			margin-bottom: 8px;
		`;
		wordsEl.textContent = this.wordCount.toString();

		const wordsLabel = contentEl.createDiv();
		wordsLabel.style.cssText = `
			font-size: 14px; color: rgba(255,255,255,0.4);
			margin-bottom: 24px;
		`;
		wordsLabel.textContent = 'words';

		// Duration
		const durationEl = contentEl.createDiv();
		durationEl.style.cssText = `
			font-size: 24px; color: rgba(255,255,255,0.7);
			margin-bottom: 8px;
		`;
		durationEl.textContent = formatDuration(this.durationMs);

		const durationLabel = contentEl.createDiv();
		durationLabel.style.cssText = `
			font-size: 12px; color: rgba(255,255,255,0.3);
			margin-bottom: 24px;
		`;
		durationLabel.textContent = 'session duration';

		// Flow score
		const flowEl = contentEl.createDiv();
		flowEl.style.cssText = `
			font-size: 24px; color: #7c3aed;
			margin-bottom: 8px;
		`;
		flowEl.textContent = `${this.flowScore}%`;

		const flowLabel = contentEl.createDiv();
		flowLabel.style.cssText = `
			font-size: 12px; color: rgba(255,255,255,0.3);
			margin-bottom: 24px;
		`;
		flowLabel.textContent = 'flow score';

		// Buttons row
		const buttonsRow = contentEl.createDiv();
		buttonsRow.style.cssText = `
			display: flex; gap: 12px; align-items: center;
			margin-top: 8px;
		`;

		// Open button
		const button = buttonsRow.createEl('button');
		button.textContent = 'open in vault \u2192';
		button.style.cssText = `
			background: #7c3aed; color: #fff; border: none;
			padding: 12px 24px; font-size: 14px; font-family: Georgia, serif;
			border-radius: 6px; cursor: pointer;
		`;
		button.addEventListener('click', async () => {
			this.close();
			await this.app.workspace.openLinkText(this.filePath, '', false);
		});

		// Info button
		const infoBtn = buttonsRow.createEl('button');
		infoBtn.textContent = 'ⓘ';
		infoBtn.style.cssText = `
			background: transparent; color: rgba(255,255,255,0.4); border: 1px solid rgba(255,255,255,0.15);
			width: 36px; height: 36px; font-size: 18px;
			border-radius: 50%; cursor: pointer;
			display: flex; align-items: center; justify-content: center;
		`;
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

		modalEl.style.cssText = `
			max-width: 420px; margin: auto; padding: 0;
			border: 1px solid #2a2050; border-radius: 12px;
			background: #0e0a1a;
		`;

		contentEl.style.cssText = `
			padding: 32px; text-align: center;
			font-family: Georgia, serif;
		`;

		contentEl.empty();

		const title = contentEl.createDiv();
		title.style.cssText = `
			font-size: 20px; font-weight: 200; color: #e8e2f8;
			margin-bottom: 16px;
		`;
		title.textContent = 'anky';

		const desc = contentEl.createDiv();
		desc.style.cssText = `
			font-size: 14px; line-height: 1.7; color: rgba(255,255,255,0.5);
			margin-bottom: 24px;
		`;
		desc.textContent = 'to unlock the full anky experience — reflections, insights, and more — download the mobile app.';

		const link = contentEl.createEl('a');
		link.href = 'https://testflight.apple.com/join/WcRYyCm5';
		link.textContent = 'download on testflight →';
		link.style.cssText = `
			display: inline-block; background: #7c3aed; color: #fff;
			border: none; padding: 12px 24px; font-size: 14px;
			font-family: Georgia, serif; border-radius: 6px;
			cursor: pointer; text-decoration: none; letter-spacing: 0.03em;
		`;
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
		return this.file?.basename.slice(0, 8) + '...' || 'anky';
	}

	setPlugin(plugin: AnkyPlugin) {
		this.plugin = plugin;
	}

	async onLoadFile(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		this.renderSession(content, file.basename);
		this.fileKeyHandler = (e: KeyboardEvent) => this.handleFileKey(e);
		this.contentEl.tabIndex = 0;
		this.contentEl.addEventListener('keydown', this.fileKeyHandler);
		this.contentEl.focus();
	}

	private async handleFileKey(e: KeyboardEvent) {
		if (e.key === 'Backspace' || e.key === 'Delete') {
			e.preventDefault();
			window.history.back();
			return;
		}

		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			e.preventDefault();
			await this.navigateSibling(e.key === 'ArrowRight' ? 1 : -1);
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

	async onUnloadFile(): Promise<void> {
		if (this.fileKeyHandler) {
			this.contentEl.removeEventListener('keydown', this.fileKeyHandler);
		}
		this.contentEl.empty();
	}

	private renderSession(content: string, hash: string) {
		this.contentEl.empty();
		this.contentEl.style.cssText = `
			background: #06040f; color: #d4c8b8;
			font-family: Georgia, serif;
			height: 100%; overflow-y: auto;
		`;

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
		const topBar = this.contentEl.createDiv();
		topBar.style.cssText = `
			display: flex; align-items: center; justify-content: space-between;
			padding: 16px 32px; border-bottom: 1px solid #1a1030;
		`;

		const leftButtons = topBar.createDiv();
		leftButtons.style.cssText = 'display: flex; align-items: center; gap: 12px;';

		const mapBtn = leftButtons.createEl('button');
		mapBtn.textContent = 'map';
		mapBtn.style.cssText = `
			background: transparent; color: #7c3aed; border: 1px solid #7c3aed;
			padding: 4px 12px; font-size: 12px; font-family: Georgia, serif;
			border-radius: 4px; cursor: pointer; letter-spacing: 0.08em;
		`;
		mapBtn.addEventListener('click', () => {
			this.openMapView();
		});

		const statsRow = leftButtons.createDiv();
		statsRow.style.cssText = 'display: flex; gap: 24px;';

		const rightButtons = topBar.createDiv();
		rightButtons.style.cssText = 'display: flex; align-items: center; gap: 12px;';

		const infoBtn = rightButtons.createEl('button');
		infoBtn.textContent = 'ⓘ';
		infoBtn.style.cssText = `
			background: transparent; color: rgba(255,255,255,0.4); border: 1px solid rgba(255,255,255,0.15);
			width: 28px; height: 28px; font-size: 16px;
			border-radius: 50%; cursor: pointer;
			display: flex; align-items: center; justify-content: center;
		`;
		infoBtn.addEventListener('click', () => {
			new AnkyInfoModal(this.app).open();
		});

		const deleteBtn = rightButtons.createEl('button');
		deleteBtn.textContent = 'delete session';
		deleteBtn.style.cssText = `
			background: transparent; color: #ef4444; border: 1px solid #ef4444;
			padding: 4px 12px; font-size: 12px; font-family: Georgia, serif;
			border-radius: 4px; cursor: pointer; letter-spacing: 0.08em;
		`;
		deleteBtn.addEventListener('click', async () => {
			const file = this.file;
			if (!file) return;
			const confirmed = confirm('delete this session?');
			if (!confirmed) return;
			await this.app.vault.delete(file);
			window.history.back();
		});

		const addStat = (value: string, label: string) => {
			const s = statsRow.createDiv();
			s.style.textAlign = 'center';
			const n = s.createDiv();
			n.style.cssText =
				'font-size:22px;font-weight:200;color:#e8e2f8;letter-spacing:-0.5px;';
			n.textContent = value;
			const l = s.createDiv();
			l.style.cssText =
				'font-size:9px;color:#444;letter-spacing:0.12em;text-transform:uppercase;margin-top:3px;';
			l.textContent = label;
		};

		addStat(
			date.toLocaleDateString('en', { month: 'short', day: 'numeric' }),
			'date'
		);
		addStat(duration, 'duration');
		addStat(String(words), 'words');
		addStat(flowScore + '%', 'flow');

		// Text content
		const textPanel = this.contentEl.createDiv();
		textPanel.style.cssText = `
			flex: 1; padding: 32px; overflow-y: auto;
			max-width: 720px; margin: 0 auto;
		`;

		const body = textPanel.createDiv();
		body.style.cssText = `
			font-size: 16px; line-height: 1.85; color: #9d9488;
			font-style: italic;
			white-space: pre-wrap; word-wrap: break-word;
		`;
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
		return 'anky map';
	}

	getIcon(): string {
		return 'map';
	}

	async onOpen() {
		await this.renderMap();
		this.keyHandler = (e: KeyboardEvent) => this.handleKey(e);
		this.contentEl.tabIndex = 0;
		this.contentEl.addEventListener('keydown', this.keyHandler);
		this.contentEl.focus();
	}

	async onClose() {
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
				this.app.workspace.openLinkText(this.sessions[this.selectedIndex].path, '', false);
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
			old.style.transform = 'scale(1)';
			old.style.zIndex = '0';
			old.style.outline = 'none';
		}

		this.selectedIndex = index;

		// Select new
		const cell = this.cells[index];
		cell.style.transform = 'scale(1.3)';
		cell.style.zIndex = '10';
		cell.style.outline = '2px solid #e8e2f8';
		cell.scrollIntoView({ block: 'nearest' });

		// Update info panel + preview
		this.updateInfo(this.sessions[index]);
		this.updatePreview(this.sessions[index]);
	}

	private updateInfo(session: SessionSummary) {
		if (!this.infoEl) return;
		const durationMin = Math.floor(session.durationMs / 60000);
		const durationSec = Math.floor((session.durationMs % 60000) / 1000);
		const dateStr = session.date.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
		const dur = `${durationMin}:${durationSec.toString().padStart(2, '0')}`;
		const ankyLabel = session.isAnky
			? '<span style="color:#7c3aed;">anky</span>'
			: '<span style="color:#444;">session</span>';

		this.infoEl.innerHTML = `${ankyLabel} &nbsp;&middot;&nbsp; ${dateStr} &nbsp;&middot;&nbsp; ${dur} &nbsp;&middot;&nbsp; ${session.words} words &nbsp;&nbsp; <span style="color:rgba(255,255,255,0.2);font-size:11px;">space to open</span>`;
	}

	private updatePreview(session: SessionSummary) {
		if (!this.previewEl) return;
		this.previewEl.empty();

		const dateStr = session.date.toLocaleDateString('en', { month: 'short', day: 'numeric' });
		const durationMin = Math.floor(session.durationMs / 60000);
		const durationSec = Math.floor((session.durationMs % 60000) / 1000);
		const dur = `${durationMin}:${durationSec.toString().padStart(2, '0')}`;

		const header = this.previewEl.createDiv();
		header.style.cssText = `
			display: flex; gap: 16px; margin-bottom: 20px;
			padding-bottom: 12px; border-bottom: 1px solid #1a1030;
			font-size: 13px; color: rgba(255,255,255,0.4);
		`;
		header.innerHTML = `<span style="color:#e8e2f8;">${dateStr}</span> <span>${dur}</span> <span>${session.words} words</span> <span>${session.isAnky ? '<span style="color:#7c3aed;">anky</span>' : 'session'}</span>`;

		const textEl = this.previewEl.createDiv();
		textEl.style.cssText = `
			font-size: 15px; line-height: 1.8; color: #9d9488;
			font-style: italic; white-space: pre-wrap; word-wrap: break-word;
		`;
		textEl.textContent = session.text;
	}

	private async renderMap() {
		this.contentEl.empty();
		this.cells = [];
		this.selectedIndex = -1;
		this.contentEl.style.cssText = `
			background: #06040f; color: #d4c8b8;
			font-family: Georgia, serif;
			height: 100%; overflow: hidden; outline: none;
			display: flex; flex-direction: column;
		`;

		const header = this.contentEl.createDiv();
		header.style.cssText = `
			display: flex; align-items: center; justify-content: space-between;
			padding: 24px 32px 16px 32px; flex-shrink: 0;
		`;

		const title = header.createDiv();
		title.style.cssText = 'font-size: 24px; font-weight: 200; color: #e8e2f8;';
		title.textContent = 'anky map';

		// Scan all .anky files
		this.sessions = await this.scanSessions();

		const totalCount = this.sessions.length;
		const ankyCount = this.sessions.filter(s => s.isAnky).length;

		const summaryEl = header.createDiv();
		summaryEl.style.cssText = `
			font-size: 14px; color: rgba(255,255,255,0.4);
			display: flex; gap: 24px;
		`;

		const totalEl = summaryEl.createDiv();
		totalEl.innerHTML = `<span style="color:#e8e2f8;font-size:20px;font-weight:200;">${totalCount}</span> sessions`;

		const ankyEl = summaryEl.createDiv();
		ankyEl.innerHTML = `<span style="color:#7c3aed;font-size:20px;font-weight:200;">${ankyCount}</span> ankys`;

		// Main layout: grid left, preview right
		const mainLayout = this.contentEl.createDiv();
		mainLayout.style.cssText = `
			display: flex; flex: 1; min-height: 0; overflow: hidden;
		`;

		// Left side: legend + info + grid
		const leftPanel = mainLayout.createDiv();
		leftPanel.style.cssText = `
			flex: 0 0 340px; width: 340px; padding: 0 32px 32px 32px; overflow-y: auto;
			border-right: 1px solid #1a1030;
		`;

		// Legend
		const legend = leftPanel.createDiv();
		legend.style.cssText = `
			display: flex; gap: 16px; margin-bottom: 16px;
			font-size: 12px; color: rgba(255,255,255,0.4);
			align-items: center;
		`;

		const addLegendItem = (color: string, label: string) => {
			const item = legend.createDiv();
			item.style.cssText = 'display: flex; align-items: center; gap: 6px;';
			const dot = item.createDiv();
			dot.style.cssText = `width: 12px; height: 12px; border-radius: 2px; background: ${color};`;
			const text = item.createDiv();
			text.textContent = label;
		};

		addLegendItem('#7c3aed', 'anky (8+ min)');
		addLegendItem('#1a1030', 'session (< 8 min)');

		// Info panel
		this.infoEl = leftPanel.createDiv();
		this.infoEl.style.cssText = `
			font-size: 13px; color: rgba(255,255,255,0.5);
			margin-bottom: 16px; min-height: 20px;
			font-family: Georgia, serif;
		`;
		this.infoEl.innerHTML = '<span style="color:rgba(255,255,255,0.2);">arrow keys to navigate, space to open</span>';

		// Grid
		this.sessions.sort((a, b) => a.date.getTime() - b.date.getTime());

		const grid = leftPanel.createDiv();
		grid.style.cssText = `
			display: flex; flex-wrap: wrap; gap: 6px;
		`;

		for (let i = 0; i < this.sessions.length; i++) {
			const session = this.sessions[i];
			const cell = grid.createDiv();
			const bg = session.isAnky ? '#7c3aed' : '#1a1030';
			const border = session.isAnky ? '1px solid #9b6aed' : '1px solid #2a2050';

			cell.style.cssText = `
				width: 32px; height: 32px; border-radius: 4px;
				background: ${bg}; border: ${border};
				cursor: pointer; position: relative;
				transition: transform 0.15s ease, outline 0.15s ease;
				outline: none;
			`;

			const idx = i;
			cell.addEventListener('mouseenter', () => {
				this.selectCell(idx);
			});
			cell.addEventListener('mouseleave', () => {
				if (this.selectedIndex === idx) {
					cell.style.transform = 'scale(1)';
					cell.style.zIndex = '0';
					cell.style.outline = 'none';
				}
			});

			cell.addEventListener('click', async () => {
				await this.app.workspace.openLinkText(session.path, '', false);
			});

			this.cells.push(cell);
		}

		if (this.sessions.length === 0) {
			const empty = leftPanel.createDiv();
			empty.style.cssText = `
				text-align: center; color: rgba(255,255,255,0.3);
				font-size: 16px; margin-top: 64px;
			`;
			empty.textContent = 'no sessions yet. start writing!';
		}

		// Right side: preview panel
		this.previewEl = mainLayout.createDiv();
		this.previewEl.style.cssText = `
			flex: 1; padding: 16px 32px 32px 32px; overflow-y: auto;
		`;

		const previewHint = this.previewEl.createDiv();
		previewHint.style.cssText = `
			color: rgba(255,255,255,0.15); font-size: 14px;
			margin-top: 40px; text-align: center;
		`;
		previewHint.textContent = 'select a session to preview';
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
					.onChange(async (value) => {
						this.plugin.settings.sessionFolder = value || 'ankys';
						await this.plugin.saveSettings();
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
			id: 'start-anky-session',
			name: 'Start writing session',
			hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'a' }],
			callback: () => {
				new AnkyWritingModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'open-anky-map',
			name: 'Open anky map',
			callback: async () => {
				const existing = this.app.workspace.getLeavesOfType(ANKY_MAP_VIEW_TYPE);
				if (existing.length > 0) {
					this.app.workspace.revealLeaf(existing[0]);
					return;
				}
				const leaf = this.app.workspace.getLeaf(true);
				await leaf.setViewState({ type: ANKY_MAP_VIEW_TYPE, active: true });
				this.app.workspace.revealLeaf(leaf);
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
