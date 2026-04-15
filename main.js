var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => AnkyPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  sessionFolder: "ankys"
};
function buildAnkyString(buffer) {
  return buffer.map((k) => `${k.ms} ${k.char}`).join("\n");
}
function computeHash(content) {
  return __async(this, null, function* () {
    const bytes = new TextEncoder().encode(content);
    const hashBuffer = yield crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  });
}
function reconstructText(buffer) {
  return buffer.map((k) => k.char === "SPACE" ? " " : k.char).join("");
}
function computeFlowScore(buffer, totalDurationMs) {
  const deltas = buffer.filter((k) => !k.first).map((k) => k.ms);
  if (deltas.length < 2)
    return 0;
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const variance = deltas.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / deltas.length;
  const stddev = Math.sqrt(variance);
  const rhythm = Math.max(0, Math.min(1, 1 - stddev / mean));
  const words = reconstructText(buffer).trim().split(/\s+/).length;
  const durationMinutes = totalDurationMs / 6e4;
  const velocity = Math.min(1, words / durationMinutes / 60);
  const longPauses = deltas.filter((d) => d > 3e3).length;
  const attention = Math.max(0, 1 - longPauses * 0.05);
  const duration = Math.min(1, totalDurationMs / 48e4);
  return Math.round(
    (rhythm * 0.3 + velocity * 0.25 + attention * 0.25 + duration * 0.2) * 100
  );
}
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1e3);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}
var AnkyWritingModal = class extends import_obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.keystrokeBuffer = [];
    this.firstKeystrokeEpochMs = 0;
    this.lastKeystrokeTime = 0;
    this.idleTimer = null;
    this.idleShowTimer = null;
    this.sessionActive = false;
    this.writingArea = null;
    this.placeholderEl = null;
    this.idleBarFill = null;
    this.idleBarTrack = null;
    this.progressBarFill = null;
    this.timerEl = null;
    this.animFrameId = null;
    this.keydownHandler = null;
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
    const closeButton = modalEl.querySelector(".modal-close-button");
    if (closeButton)
      closeButton.style.display = "none";
    contentEl.style.cssText = `
			display: flex; flex-direction: column; flex: 1;
			padding: 0; margin: 0; overflow: hidden;
		`;
    contentEl.empty();
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
    this.placeholderEl.textContent = "what is alive in you right now?";
    this.writingArea = writingWrapper.createDiv();
    this.writingArea.setAttribute("contenteditable", "true");
    this.writingArea.style.cssText = `
			position: absolute; top: 0; left: 0; right: 0; bottom: 0;
			padding: 24px 32px; background: transparent;
			font-family: Georgia, serif; font-size: 17px; line-height: 1.75;
			color: #e8e2f8; caret-color: transparent; outline: none;
			border: none; overflow-y: auto; white-space: pre-wrap;
			word-wrap: break-word;
		`;
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
    this.timerEl = contentEl.createDiv();
    this.timerEl.style.cssText = `
			text-align: center; padding: 8px 16px 12px 16px;
			font-size: 13px; color: rgba(255,255,255,0.3);
			font-family: monospace; flex-shrink: 0;
		`;
    this.timerEl.textContent = "8:00";
    setTimeout(() => {
      if (this.writingArea)
        this.writingArea.focus();
    }, 50);
    this.sessionActive = true;
    this.keydownHandler = (e) => this.handleKeydown(e);
    this.writingArea.addEventListener("keydown", this.keydownHandler);
    this.writingArea.addEventListener("paste", (e) => e.preventDefault());
    this.writingArea.addEventListener("drop", (e) => e.preventDefault());
    this.writingArea.addEventListener("beforeinput", (e) => {
      if (e.inputType !== "insertText") {
        e.preventDefault();
      }
    });
  }
  startAnimationLoop() {
    const tick = () => {
      if (!this.sessionActive)
        return;
      const now = Date.now();
      const elapsed = now - this.firstKeystrokeEpochMs;
      const sinceLast = now - this.lastKeystrokeTime;
      if (this.idleBarFill) {
        const remaining = Math.max(0, 1 - sinceLast / 8e3);
        this.idleBarFill.style.width = `${remaining * 100}%`;
      }
      if (this.idleBarTrack) {
        this.idleBarTrack.style.opacity = sinceLast >= 3e3 ? "1" : "0";
      }
      if (this.progressBarFill) {
        const progress = Math.min(1, elapsed / 48e4);
        this.progressBarFill.style.width = `${progress * 100}%`;
      }
      if (this.timerEl) {
        const remainingMs = 48e4 - elapsed;
        if (remainingMs >= 0) {
          const totalSec = Math.ceil(remainingMs / 1e3);
          const m = Math.floor(totalSec / 60);
          const s = totalSec % 60;
          this.timerEl.textContent = `${m}:${s.toString().padStart(2, "0")}`;
        } else {
          const overMs = elapsed - 48e4;
          const totalSec = Math.floor(overMs / 1e3);
          const m = 8 + Math.floor(totalSec / 60);
          const s = totalSec % 60;
          this.timerEl.textContent = `${m}:${s.toString().padStart(2, "0")}`;
        }
      }
      this.animFrameId = requestAnimationFrame(tick);
    };
    this.animFrameId = requestAnimationFrame(tick);
  }
  handleKeydown(e) {
    if (!this.sessionActive)
      return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return;
    }
    const banned = [
      "Backspace",
      "Delete",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Enter",
      "Tab"
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
    const char = e.key === " " ? "SPACE" : e.key;
    const displayChar = e.key;
    const now = Date.now();
    if (this.keystrokeBuffer.length === 0) {
      this.firstKeystrokeEpochMs = now;
      this.lastKeystrokeTime = now;
      this.keystrokeBuffer.push({ ms: now, char, first: true });
      if (this.placeholderEl) {
        this.placeholderEl.style.display = "none";
      }
      this.startAnimationLoop();
    } else {
      const delta = now - this.lastKeystrokeTime;
      this.lastKeystrokeTime = now;
      this.keystrokeBuffer.push({ ms: delta, char, first: false });
    }
    if (this.writingArea) {
      this.writingArea.textContent += displayChar;
      this.writingArea.scrollTop = this.writingArea.scrollHeight;
    }
    this.resetIdleTimer();
  }
  resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleTimer = setTimeout(() => {
      this.endSession();
    }, 8e3);
  }
  endSession() {
    return __async(this, null, function* () {
      if (!this.sessionActive)
        return;
      this.sessionActive = false;
      if (this.idleTimer)
        clearTimeout(this.idleTimer);
      if (this.animFrameId)
        cancelAnimationFrame(this.animFrameId);
      if (this.keystrokeBuffer.length < 10) {
        this.close();
        return;
      }
      const ankyString = buildAnkyString(this.keystrokeBuffer);
      const hash = yield computeHash(ankyString);
      const verifyHash = yield computeHash(ankyString);
      if (verifyHash !== hash) {
        console.error("Anky: hash sanity check failed");
        this.close();
        return;
      }
      try {
        const filePath = yield this.saveSession(ankyString, hash, this.firstKeystrokeEpochMs);
        const written = yield this.app.vault.adapter.read(filePath);
        const writtenHash = yield computeHash(written);
        if (writtenHash !== hash) {
          throw new Error("hash mismatch after write");
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
        console.error("Anky: failed to save session", err);
        this.close();
      }
    });
  }
  saveSession(ankyString, hash, epochMs) {
    return __async(this, null, function* () {
      const folder = this.plugin.settings.sessionFolder;
      const date = new Date(epochMs);
      const yyyy = date.getFullYear().toString();
      const mm = (date.getMonth() + 1).toString().padStart(2, "0");
      const dd = date.getDate().toString().padStart(2, "0");
      const folderPath = `${folder}/${yyyy}/${mm}/${dd}`;
      const filePath = `${folderPath}/${hash}.anky`;
      if (!(yield this.app.vault.adapter.exists(folder)))
        yield this.app.vault.createFolder(folder);
      if (!(yield this.app.vault.adapter.exists(`${folder}/${yyyy}`)))
        yield this.app.vault.createFolder(`${folder}/${yyyy}`);
      if (!(yield this.app.vault.adapter.exists(`${folder}/${yyyy}/${mm}`)))
        yield this.app.vault.createFolder(`${folder}/${yyyy}/${mm}`);
      if (!(yield this.app.vault.adapter.exists(folderPath)))
        yield this.app.vault.createFolder(folderPath);
      yield this.app.vault.adapter.write(filePath, ankyString);
      return filePath;
    });
  }
  onClose() {
    this.sessionActive = false;
    if (this.idleTimer)
      clearTimeout(this.idleTimer);
    if (this.animFrameId)
      cancelAnimationFrame(this.animFrameId);
    this.contentEl.empty();
  }
};
var AnkyCompletionModal = class extends import_obsidian.Modal {
  constructor(app, hash, wordCount, durationMs, flowScore, filePath) {
    super(app);
    this.autoCloseTimer = null;
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
    const closeButton = modalEl.querySelector(".modal-close-button");
    if (closeButton)
      closeButton.style.display = "none";
    contentEl.style.cssText = `
			display: flex; flex-direction: column; align-items: center;
			justify-content: center; flex: 1; text-align: center;
			font-family: Georgia, serif; padding: 32px;
		`;
    contentEl.empty();
    const label = contentEl.createDiv();
    label.style.cssText = `
			font-size: 14px; color: rgba(255,255,255,0.3);
			letter-spacing: 0.15em; text-transform: uppercase;
			margin-bottom: 32px;
		`;
    label.textContent = "session complete";
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
    wordsLabel.textContent = "words";
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
    durationLabel.textContent = "session duration";
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
    flowLabel.textContent = "flow score";
    const buttonsRow = contentEl.createDiv();
    buttonsRow.style.cssText = `
			display: flex; gap: 12px; align-items: center;
			margin-top: 8px;
		`;
    const button = buttonsRow.createEl("button");
    button.textContent = "open in vault \u2192";
    button.style.cssText = `
			background: #7c3aed; color: #fff; border: none;
			padding: 12px 24px; font-size: 14px; font-family: Georgia, serif;
			border-radius: 6px; cursor: pointer;
		`;
    button.addEventListener("click", () => __async(this, null, function* () {
      this.close();
      yield this.app.workspace.openLinkText(this.filePath, "", false);
    }));
    const infoBtn = buttonsRow.createEl("button");
    infoBtn.textContent = "\u24D8";
    infoBtn.style.cssText = `
			background: transparent; color: rgba(255,255,255,0.4); border: 1px solid rgba(255,255,255,0.15);
			width: 36px; height: 36px; font-size: 18px;
			border-radius: 50%; cursor: pointer;
			display: flex; align-items: center; justify-content: center;
		`;
    infoBtn.addEventListener("click", () => {
      new AnkyInfoModal(this.app).open();
    });
    this.autoCloseTimer = setTimeout(() => {
      this.close();
    }, 3e4);
  }
  onClose() {
    if (this.autoCloseTimer)
      clearTimeout(this.autoCloseTimer);
    this.contentEl.empty();
  }
};
var ANKY_VIEW_TYPE = "anky-view";
var ANKY_MAP_VIEW_TYPE = "anky-map-view";
var AnkyInfoModal = class extends import_obsidian.Modal {
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
    title.textContent = "anky";
    const desc = contentEl.createDiv();
    desc.style.cssText = `
			font-size: 14px; line-height: 1.7; color: rgba(255,255,255,0.5);
			margin-bottom: 24px;
		`;
    desc.textContent = "to unlock the full anky experience \u2014 reflections, insights, and more \u2014 get the mobile app.";
    const buttonContainer = contentEl.createDiv();
    buttonContainer.style.cssText = "display: flex; gap: 12px; flex-wrap: wrap;";
    const buttonStyle = `
			display: inline-block; color: #fff;
			border: none; padding: 12px 24px; font-size: 14px;
			font-family: Georgia, serif; border-radius: 6px;
			cursor: pointer; text-decoration: none; letter-spacing: 0.03em;
		`;
    const copyBtn = buttonContainer.createEl("button");
    copyBtn.textContent = "copy testflight link";
    copyBtn.style.cssText = buttonStyle + "background: #7c3aed;";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText("https://testflight.apple.com/join/WcRYyCm5");
      copyBtn.textContent = "copied!";
      setTimeout(() => {
        copyBtn.textContent = "copy testflight link";
      }, 2e3);
    });
    const contactBtn = buttonContainer.createEl("a");
    contactBtn.href = "https://x.com/jpfraneto";
    contactBtn.textContent = "contact the dev \u2192";
    contactBtn.style.cssText = buttonStyle + "background: #1d9bf0;";
  }
  onClose() {
    this.contentEl.empty();
  }
};
var AnkyFileView = class extends import_obsidian.FileView {
  constructor() {
    super(...arguments);
    this.plugin = null;
    this.fileKeyHandler = null;
  }
  getViewType() {
    return ANKY_VIEW_TYPE;
  }
  getDisplayText() {
    var _a;
    return ((_a = this.file) == null ? void 0 : _a.basename.slice(0, 8)) + "..." || "anky";
  }
  setPlugin(plugin) {
    this.plugin = plugin;
  }
  onLoadFile(file) {
    return __async(this, null, function* () {
      const content = yield this.app.vault.read(file);
      this.renderSession(content, file.basename);
      this.fileKeyHandler = (e) => this.handleFileKey(e);
      this.contentEl.tabIndex = 0;
      this.contentEl.addEventListener("keydown", this.fileKeyHandler);
      this.contentEl.focus();
    });
  }
  handleFileKey(e) {
    return __async(this, null, function* () {
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        window.history.back();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        yield this.navigateSibling(e.key === "ArrowRight" ? 1 : -1);
        return;
      }
    });
  }
  navigateSibling(direction) {
    return __async(this, null, function* () {
      if (!this.file || !this.plugin)
        return;
      const folder = this.plugin.settings.sessionFolder;
      const root = this.app.vault.getAbstractFileByPath(folder);
      if (!root || !(root instanceof import_obsidian.TFolder))
        return;
      const allFiles = [];
      const collect = (f) => {
        for (const child of f.children) {
          if (child instanceof import_obsidian.TFile && child.extension === "anky") {
            allFiles.push(child);
          } else if (child instanceof import_obsidian.TFolder) {
            collect(child);
          }
        }
      };
      collect(root);
      allFiles.sort((a, b) => a.path.localeCompare(b.path));
      const currentIdx = allFiles.findIndex((f) => {
        var _a;
        return f.path === ((_a = this.file) == null ? void 0 : _a.path);
      });
      if (currentIdx < 0)
        return;
      const nextIdx = currentIdx + direction;
      if (nextIdx < 0 || nextIdx >= allFiles.length)
        return;
      yield this.app.workspace.openLinkText(allFiles[nextIdx].path, "", false);
    });
  }
  onUnloadFile() {
    return __async(this, null, function* () {
      if (this.fileKeyHandler) {
        this.contentEl.removeEventListener("keydown", this.fileKeyHandler);
      }
      this.contentEl.empty();
    });
  }
  renderSession(content, hash) {
    this.contentEl.empty();
    this.contentEl.style.cssText = `
			background: #06040f; color: #d4c8b8;
			font-family: Georgia, serif;
			height: 100%; overflow-y: auto;
		`;
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0)
      return;
    const records = lines.map((line, i) => {
      const sp = line.indexOf(" ");
      const ms = parseInt(line.slice(0, sp));
      const char = line.slice(sp + 1);
      return { ms, char, first: i === 0 };
    });
    const text = records.map((r) => r.char === "SPACE" ? " " : r.char).join("");
    const epochMs = records[0].ms;
    const deltas = records.slice(1).map((r) => r.ms);
    const totalMs = deltas.reduce((a, b) => a + b, 0);
    const words = text.trim().split(/\s+/).filter((w) => w).length;
    const date = new Date(epochMs);
    const duration = `${Math.floor(totalMs / 6e4)}:${Math.floor(totalMs % 6e4 / 1e3).toString().padStart(2, "0")}`;
    let flowScore = 0;
    if (deltas.length >= 2) {
      const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const std = Math.sqrt(
        deltas.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / deltas.length
      );
      const rhythm = Math.max(0, Math.min(1, 1 - std / mean));
      const velocity = Math.min(1, words / (totalMs / 6e4) / 60);
      const attention = Math.max(0, 1 - deltas.filter((d) => d > 3e3).length * 0.05);
      const dur = Math.min(1, totalMs / 48e4);
      flowScore = Math.round(
        (rhythm * 0.3 + velocity * 0.25 + attention * 0.25 + dur * 0.2) * 100
      );
    }
    const topBar = this.contentEl.createDiv();
    topBar.style.cssText = `
			display: flex; align-items: center; justify-content: space-between;
			padding: 16px 32px; border-bottom: 1px solid #1a1030;
		`;
    const leftButtons = topBar.createDiv();
    leftButtons.style.cssText = "display: flex; align-items: center; gap: 12px;";
    const mapBtn = leftButtons.createEl("button");
    mapBtn.textContent = "map";
    mapBtn.style.cssText = `
			background: transparent; color: #7c3aed; border: 1px solid #7c3aed;
			padding: 4px 12px; font-size: 12px; font-family: Georgia, serif;
			border-radius: 4px; cursor: pointer; letter-spacing: 0.08em;
		`;
    mapBtn.addEventListener("click", () => {
      this.openMapView();
    });
    const statsRow = leftButtons.createDiv();
    statsRow.style.cssText = "display: flex; gap: 24px;";
    const rightButtons = topBar.createDiv();
    rightButtons.style.cssText = "display: flex; align-items: center; gap: 12px;";
    const infoBtn = rightButtons.createEl("button");
    infoBtn.textContent = "\u24D8";
    infoBtn.style.cssText = `
			background: transparent; color: rgba(255,255,255,0.4); border: 1px solid rgba(255,255,255,0.15);
			width: 28px; height: 28px; font-size: 16px;
			border-radius: 50%; cursor: pointer;
			display: flex; align-items: center; justify-content: center;
		`;
    infoBtn.addEventListener("click", () => {
      new AnkyInfoModal(this.app).open();
    });
    const deleteBtn = rightButtons.createEl("button");
    deleteBtn.textContent = "delete session";
    deleteBtn.style.cssText = `
			background: transparent; color: #ef4444; border: 1px solid #ef4444;
			padding: 4px 12px; font-size: 12px; font-family: Georgia, serif;
			border-radius: 4px; cursor: pointer; letter-spacing: 0.08em;
		`;
    deleteBtn.addEventListener("click", () => __async(this, null, function* () {
      const file = this.file;
      if (!file)
        return;
      const confirmed = confirm("delete this session?");
      if (!confirmed)
        return;
      yield this.app.vault.delete(file);
      window.history.back();
    }));
    const addStat = (value, label) => {
      const s = statsRow.createDiv();
      s.style.textAlign = "center";
      const n = s.createDiv();
      n.style.cssText = "font-size:22px;font-weight:200;color:#e8e2f8;letter-spacing:-0.5px;";
      n.textContent = value;
      const l = s.createDiv();
      l.style.cssText = "font-size:9px;color:#444;letter-spacing:0.12em;text-transform:uppercase;margin-top:3px;";
      l.textContent = label;
    };
    addStat(
      date.toLocaleDateString("en", { month: "short", day: "numeric" }),
      "date"
    );
    addStat(duration, "duration");
    addStat(String(words), "words");
    addStat(flowScore + "%", "flow");
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
  openMapView() {
    return __async(this, null, function* () {
      const existing = this.app.workspace.getLeavesOfType(ANKY_MAP_VIEW_TYPE);
      if (existing.length > 0) {
        this.app.workspace.revealLeaf(existing[0]);
        return;
      }
      const leaf = this.app.workspace.getLeaf(true);
      yield leaf.setViewState({ type: ANKY_MAP_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    });
  }
};
var AnkyMapView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.sessions = [];
    this.cells = [];
    this.selectedIndex = -1;
    this.infoEl = null;
    this.previewEl = null;
    this.keyHandler = null;
    this.plugin = plugin;
  }
  getViewType() {
    return ANKY_MAP_VIEW_TYPE;
  }
  getDisplayText() {
    return "anky map";
  }
  getIcon() {
    return "map";
  }
  onOpen() {
    return __async(this, null, function* () {
      yield this.renderMap();
      this.keyHandler = (e) => this.handleKey(e);
      this.contentEl.tabIndex = 0;
      this.contentEl.addEventListener("keydown", this.keyHandler);
      this.contentEl.focus();
    });
  }
  onClose() {
    return __async(this, null, function* () {
      if (this.keyHandler) {
        this.contentEl.removeEventListener("keydown", this.keyHandler);
      }
      this.contentEl.empty();
    });
  }
  handleKey(e) {
    var _a, _b, _c;
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      window.history.back();
      return;
    }
    if (this.sessions.length === 0)
      return;
    if (e.key === " ") {
      e.preventDefault();
      if (this.selectedIndex >= 0 && this.selectedIndex < this.sessions.length) {
        this.app.workspace.openLinkText(this.sessions[this.selectedIndex].path, "", false);
      }
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key))
      return;
    e.preventDefault();
    const gridWidth = (_c = (_b = (_a = this.cells[0]) == null ? void 0 : _a.parentElement) == null ? void 0 : _b.clientWidth) != null ? _c : 0;
    const cellWidth = 32 + 6;
    const cols = Math.max(1, Math.floor((gridWidth + 6) / cellWidth));
    let next = this.selectedIndex;
    if (e.key === "ArrowRight") {
      next = Math.min(this.cells.length - 1, next + 1);
    } else if (e.key === "ArrowLeft") {
      next = Math.max(0, next - 1);
    } else if (e.key === "ArrowDown") {
      next = Math.min(this.cells.length - 1, next + cols);
    } else if (e.key === "ArrowUp") {
      next = Math.max(0, next - cols);
    }
    if (next < 0)
      next = 0;
    this.selectCell(next);
  }
  selectCell(index) {
    if (this.selectedIndex >= 0 && this.selectedIndex < this.cells.length) {
      const old = this.cells[this.selectedIndex];
      old.style.transform = "scale(1)";
      old.style.zIndex = "0";
      old.style.outline = "none";
    }
    this.selectedIndex = index;
    const cell = this.cells[index];
    cell.style.transform = "scale(1.3)";
    cell.style.zIndex = "10";
    cell.style.outline = "2px solid #e8e2f8";
    cell.scrollIntoView({ block: "nearest" });
    this.updateInfo(this.sessions[index]);
    this.updatePreview(this.sessions[index]);
  }
  updateInfo(session) {
    if (!this.infoEl)
      return;
    const durationMin = Math.floor(session.durationMs / 6e4);
    const durationSec = Math.floor(session.durationMs % 6e4 / 1e3);
    const dateStr = session.date.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
    const dur = `${durationMin}:${durationSec.toString().padStart(2, "0")}`;
    const ankyLabel = session.isAnky ? '<span style="color:#7c3aed;">anky</span>' : '<span style="color:#444;">session</span>';
    this.infoEl.innerHTML = `${ankyLabel} &nbsp;&middot;&nbsp; ${dateStr} &nbsp;&middot;&nbsp; ${dur} &nbsp;&middot;&nbsp; ${session.words} words &nbsp;&nbsp; <span style="color:rgba(255,255,255,0.2);font-size:11px;">space to open</span>`;
  }
  updatePreview(session) {
    if (!this.previewEl)
      return;
    this.previewEl.empty();
    const dateStr = session.date.toLocaleDateString("en", { month: "short", day: "numeric" });
    const durationMin = Math.floor(session.durationMs / 6e4);
    const durationSec = Math.floor(session.durationMs % 6e4 / 1e3);
    const dur = `${durationMin}:${durationSec.toString().padStart(2, "0")}`;
    const header = this.previewEl.createDiv();
    header.style.cssText = `
			display: flex; gap: 16px; margin-bottom: 20px;
			padding-bottom: 12px; border-bottom: 1px solid #1a1030;
			font-size: 13px; color: rgba(255,255,255,0.4);
		`;
    header.innerHTML = `<span style="color:#e8e2f8;">${dateStr}</span> <span>${dur}</span> <span>${session.words} words</span> <span>${session.isAnky ? '<span style="color:#7c3aed;">anky</span>' : "session"}</span>`;
    const textEl = this.previewEl.createDiv();
    textEl.style.cssText = `
			font-size: 15px; line-height: 1.8; color: #9d9488;
			font-style: italic; white-space: pre-wrap; word-wrap: break-word;
		`;
    textEl.textContent = session.text;
  }
  renderMap() {
    return __async(this, null, function* () {
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
      title.style.cssText = "font-size: 24px; font-weight: 200; color: #e8e2f8;";
      title.textContent = "anky map";
      this.sessions = yield this.scanSessions();
      const totalCount = this.sessions.length;
      const ankyCount = this.sessions.filter((s) => s.isAnky).length;
      const summaryEl = header.createDiv();
      summaryEl.style.cssText = `
			font-size: 14px; color: rgba(255,255,255,0.4);
			display: flex; gap: 24px;
		`;
      const totalEl = summaryEl.createDiv();
      totalEl.innerHTML = `<span style="color:#e8e2f8;font-size:20px;font-weight:200;">${totalCount}</span> sessions`;
      const ankyEl = summaryEl.createDiv();
      ankyEl.innerHTML = `<span style="color:#7c3aed;font-size:20px;font-weight:200;">${ankyCount}</span> ankys`;
      const mainLayout = this.contentEl.createDiv();
      mainLayout.style.cssText = `
			display: flex; flex: 1; min-height: 0; overflow: hidden;
		`;
      const leftPanel = mainLayout.createDiv();
      leftPanel.style.cssText = `
			flex: 0 0 340px; width: 340px; padding: 0 32px 32px 32px; overflow-y: auto;
			border-right: 1px solid #1a1030;
		`;
      const legend = leftPanel.createDiv();
      legend.style.cssText = `
			display: flex; gap: 16px; margin-bottom: 16px;
			font-size: 12px; color: rgba(255,255,255,0.4);
			align-items: center;
		`;
      const addLegendItem = (color, label) => {
        const item = legend.createDiv();
        item.style.cssText = "display: flex; align-items: center; gap: 6px;";
        const dot = item.createDiv();
        dot.style.cssText = `width: 12px; height: 12px; border-radius: 2px; background: ${color};`;
        const text = item.createDiv();
        text.textContent = label;
      };
      addLegendItem("#7c3aed", "anky (8+ min)");
      addLegendItem("#1a1030", "session (< 8 min)");
      this.infoEl = leftPanel.createDiv();
      this.infoEl.style.cssText = `
			font-size: 13px; color: rgba(255,255,255,0.5);
			margin-bottom: 16px; min-height: 20px;
			font-family: Georgia, serif;
		`;
      this.infoEl.innerHTML = '<span style="color:rgba(255,255,255,0.2);">arrow keys to navigate, space to open</span>';
      this.sessions.sort((a, b) => a.date.getTime() - b.date.getTime());
      const grid = leftPanel.createDiv();
      grid.style.cssText = `
			display: flex; flex-wrap: wrap; gap: 6px;
		`;
      for (let i = 0; i < this.sessions.length; i++) {
        const session = this.sessions[i];
        const cell = grid.createDiv();
        const bg = session.isAnky ? "#7c3aed" : "#1a1030";
        const border = session.isAnky ? "1px solid #9b6aed" : "1px solid #2a2050";
        cell.style.cssText = `
				width: 32px; height: 32px; border-radius: 4px;
				background: ${bg}; border: ${border};
				cursor: pointer; position: relative;
				transition: transform 0.15s ease, outline 0.15s ease;
				outline: none;
			`;
        const idx = i;
        cell.addEventListener("mouseenter", () => {
          this.selectCell(idx);
        });
        cell.addEventListener("mouseleave", () => {
          if (this.selectedIndex === idx) {
            cell.style.transform = "scale(1)";
            cell.style.zIndex = "0";
            cell.style.outline = "none";
          }
        });
        cell.addEventListener("click", () => __async(this, null, function* () {
          yield this.app.workspace.openLinkText(session.path, "", false);
        }));
        this.cells.push(cell);
      }
      if (this.sessions.length === 0) {
        const empty = leftPanel.createDiv();
        empty.style.cssText = `
				text-align: center; color: rgba(255,255,255,0.3);
				font-size: 16px; margin-top: 64px;
			`;
        empty.textContent = "no sessions yet. start writing!";
      }
      this.previewEl = mainLayout.createDiv();
      this.previewEl.style.cssText = `
			flex: 1; padding: 16px 32px 32px 32px; overflow-y: auto;
		`;
      const previewHint = this.previewEl.createDiv();
      previewHint.style.cssText = `
			color: rgba(255,255,255,0.15); font-size: 14px;
			margin-top: 40px; text-align: center;
		`;
      previewHint.textContent = "select a session to preview";
    });
  }
  scanSessions() {
    return __async(this, null, function* () {
      const folder = this.plugin.settings.sessionFolder;
      const sessions = [];
      const collectFiles = (f) => {
        for (const child of f.children) {
          if (child instanceof import_obsidian.TFile && child.extension === "anky") {
            sessions.push({ path: child.path, hash: child.basename, date: /* @__PURE__ */ new Date(), durationMs: 0, words: 0, isAnky: false, text: "" });
          } else if (child instanceof import_obsidian.TFolder) {
            collectFiles(child);
          }
        }
      };
      const root = this.app.vault.getAbstractFileByPath(folder);
      if (root instanceof import_obsidian.TFolder) {
        collectFiles(root);
      }
      for (const session of sessions) {
        try {
          const content = yield this.app.vault.adapter.read(session.path);
          const lines = content.split("\n").filter((l) => l.trim());
          if (lines.length === 0)
            continue;
          const records = lines.map((line, i) => {
            const sp = line.indexOf(" ");
            const ms = parseInt(line.slice(0, sp));
            const char = line.slice(sp + 1);
            return { ms, char, first: i === 0 };
          });
          const text = records.map((r) => r.char === "SPACE" ? " " : r.char).join("");
          const epochMs = records[0].ms;
          const deltas = records.slice(1).map((r) => r.ms);
          const totalMs = deltas.reduce((a, b) => a + b, 0);
          session.date = new Date(epochMs);
          session.durationMs = totalMs;
          session.words = text.trim().split(/\s+/).filter((w) => w).length;
          session.isAnky = totalMs >= 48e4;
          session.text = text;
        } catch (e) {
        }
      }
      return sessions;
    });
  }
};
var AnkySettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Session folder").setDesc("Folder within your vault where .anky files are saved.").addText(
      (text) => text.setPlaceholder("ankys").setValue(this.plugin.settings.sessionFolder).onChange((value) => __async(this, null, function* () {
        this.plugin.settings.sessionFolder = value || "ankys";
        yield this.plugin.saveSettings();
      }))
    );
  }
};
var AnkyPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
  }
  onload() {
    return __async(this, null, function* () {
      yield this.loadSettings();
      this.registerView(ANKY_VIEW_TYPE, (leaf) => {
        const view = new AnkyFileView(leaf);
        view.setPlugin(this);
        return view;
      });
      this.registerView(ANKY_MAP_VIEW_TYPE, (leaf) => new AnkyMapView(leaf, this));
      this.registerExtensions(["anky"], ANKY_VIEW_TYPE);
      this.addCommand({
        id: "start-anky-session",
        name: "Start writing session",
        hotkeys: [{ modifiers: ["Mod", "Shift"], key: "a" }],
        callback: () => {
          new AnkyWritingModal(this.app, this).open();
        }
      });
      this.addCommand({
        id: "open-anky-map",
        name: "Open anky map",
        callback: () => __async(this, null, function* () {
          const existing = this.app.workspace.getLeavesOfType(ANKY_MAP_VIEW_TYPE);
          if (existing.length > 0) {
            this.app.workspace.revealLeaf(existing[0]);
            return;
          }
          const leaf = this.app.workspace.getLeaf(true);
          yield leaf.setViewState({ type: ANKY_MAP_VIEW_TYPE, active: true });
          this.app.workspace.revealLeaf(leaf);
        })
      });
      this.addSettingTab(new AnkySettingTab(this.app, this));
    });
  }
  loadSettings() {
    return __async(this, null, function* () {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, yield this.loadData());
    });
  }
  saveSettings() {
    return __async(this, null, function* () {
      yield this.saveData(this.settings);
    });
  }
};
