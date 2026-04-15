var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __reflectGet = Reflect.get;
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
var __superGet = (cls, obj, key) => __reflectGet(__getProtoOf(cls), key, obj);
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
var AnkyConfirmModal = class extends import_obsidian.Modal {
  constructor(app, message) {
    super(app);
    this.resolved = false;
    this.resolvePromise = null;
    this.message = message;
  }
  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("anky-confirm-modal");
    contentEl.addClass("anky-confirm-content");
    contentEl.empty();
    const msg = contentEl.createDiv({ cls: "anky-confirm-message" });
    msg.textContent = this.message;
    const buttons = contentEl.createDiv({ cls: "anky-confirm-buttons" });
    const cancelBtn = buttons.createEl("button", { cls: "anky-btn-cancel" });
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      this.resolved = true;
      if (this.resolvePromise)
        this.resolvePromise(false);
      this.close();
    });
    const confirmBtn = buttons.createEl("button", { cls: "anky-btn-danger" });
    confirmBtn.textContent = "Delete";
    confirmBtn.addEventListener("click", () => {
      this.resolved = true;
      if (this.resolvePromise)
        this.resolvePromise(true);
      this.close();
    });
  }
  onClose() {
    if (!this.resolved && this.resolvePromise) {
      this.resolvePromise(false);
    }
    this.contentEl.empty();
  }
  waitForResult() {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }
};
var AnkyWritingModal = class extends import_obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.keystrokeBuffer = [];
    this.firstKeystrokeEpochMs = 0;
    this.lastKeystrokeTime = 0;
    this.idleTimer = null;
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
    modalEl.addClass("anky-writing-modal");
    containerEl.addClass("anky-writing-container");
    const closeButton = modalEl.querySelector(".modal-close-button");
    if (closeButton)
      closeButton.addClass("anky-close-button-hidden");
    contentEl.addClass("anky-writing-content");
    contentEl.empty();
    this.idleBarTrack = contentEl.createDiv({ cls: "anky-idle-bar-track" });
    this.idleBarFill = this.idleBarTrack.createDiv({ cls: "anky-idle-bar-fill" });
    const writingWrapper = contentEl.createDiv({ cls: "anky-writing-wrapper" });
    this.placeholderEl = writingWrapper.createDiv({ cls: "anky-placeholder" });
    this.placeholderEl.textContent = "What is alive in you right now?";
    this.writingArea = writingWrapper.createDiv({ cls: "anky-writing-area" });
    this.writingArea.setAttribute("contenteditable", "true");
    const progressBarTrack = contentEl.createDiv({ cls: "anky-progress-bar-track" });
    this.progressBarFill = progressBarTrack.createDiv({ cls: "anky-progress-bar-fill" });
    this.timerEl = contentEl.createDiv({ cls: "anky-timer" });
    this.timerEl.textContent = "8:00";
    setTimeout(() => {
      if (this.writingArea)
        this.writingArea.focus();
    }, 50);
    this.sessionActive = true;
    this.keydownHandler = (e) => {
      this.handleKeydown(e);
    };
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
        this.idleBarFill.setCssProps({ "--anky-idle-width": `${remaining * 100}%` });
        this.idleBarFill.style.width = `${remaining * 100}%`;
      }
      if (this.idleBarTrack) {
        if (sinceLast >= 3e3) {
          this.idleBarTrack.addClass("anky-idle-bar-track--visible");
        } else {
          this.idleBarTrack.removeClass("anky-idle-bar-track--visible");
        }
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
        this.placeholderEl.addClass("anky-placeholder--hidden");
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
      void this.endSession();
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
    modalEl.addClass("anky-completion-modal");
    containerEl.addClass("anky-writing-container");
    const closeButton = modalEl.querySelector(".modal-close-button");
    if (closeButton)
      closeButton.addClass("anky-close-button-hidden");
    contentEl.addClass("anky-completion-content");
    contentEl.empty();
    const label = contentEl.createDiv({ cls: "anky-completion-label" });
    label.textContent = "Session complete";
    const wordsEl = contentEl.createDiv({ cls: "anky-completion-word-count" });
    wordsEl.textContent = this.wordCount.toString();
    const wordsLabel = contentEl.createDiv({ cls: "anky-completion-words-label" });
    wordsLabel.textContent = "Words";
    const durationEl = contentEl.createDiv({ cls: "anky-completion-duration" });
    durationEl.textContent = formatDuration(this.durationMs);
    const durationLabel = contentEl.createDiv({ cls: "anky-completion-duration-label" });
    durationLabel.textContent = "Session duration";
    const flowEl = contentEl.createDiv({ cls: "anky-completion-flow" });
    flowEl.textContent = `${this.flowScore}%`;
    const flowLabel = contentEl.createDiv({ cls: "anky-completion-flow-label" });
    flowLabel.textContent = "Flow score";
    const buttonsRow = contentEl.createDiv({ cls: "anky-completion-buttons" });
    const button = buttonsRow.createEl("button", { cls: "anky-btn-primary" });
    button.textContent = "Open in vault";
    button.addEventListener("click", () => {
      this.close();
      void this.app.workspace.openLinkText(this.filePath, "", false);
    });
    const infoBtn = buttonsRow.createEl("button", { cls: "anky-btn-info" });
    infoBtn.textContent = "\u24D8";
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
    modalEl.addClass("anky-info-modal");
    contentEl.addClass("anky-info-content");
    contentEl.empty();
    const title = contentEl.createDiv({ cls: "anky-info-title" });
    title.textContent = "Anky";
    const desc = contentEl.createDiv({ cls: "anky-info-desc" });
    desc.textContent = "To unlock the full Anky experience \u2014 reflections, insights, and more \u2014 get the mobile app.";
    const buttonContainer = contentEl.createDiv({ cls: "anky-info-buttons" });
    const copyBtn = buttonContainer.createEl("button", { cls: "anky-btn anky-btn--purple" });
    copyBtn.textContent = "Copy TestFlight link";
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText("https://testflight.apple.com/join/WcRYyCm5").then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy TestFlight link";
        }, 2e3);
      });
    });
    const contactBtn = buttonContainer.createEl("a", { cls: "anky-btn anky-btn--blue" });
    contactBtn.href = "https://x.com/jpfraneto";
    contactBtn.textContent = "Contact the dev";
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
    return ((_a = this.file) == null ? void 0 : _a.basename.slice(0, 8)) + "..." || "Anky";
  }
  setPlugin(plugin) {
    this.plugin = plugin;
  }
  onLoadFile(file) {
    return __async(this, null, function* () {
      const content = yield this.app.vault.read(file);
      this.renderSession(content, file.basename);
      this.fileKeyHandler = (e) => {
        this.handleFileKey(e);
      };
      this.contentEl.tabIndex = 0;
      this.contentEl.addEventListener("keydown", this.fileKeyHandler);
      this.contentEl.focus();
    });
  }
  handleFileKey(e) {
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      window.history.back();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      void this.navigateSibling(e.key === "ArrowRight" ? 1 : -1);
      return;
    }
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
  onUnloadFile(file) {
    return __async(this, null, function* () {
      yield __superGet(AnkyFileView.prototype, this, "onUnloadFile").call(this, file);
      if (this.fileKeyHandler) {
        this.contentEl.removeEventListener("keydown", this.fileKeyHandler);
      }
      this.contentEl.empty();
    });
  }
  renderSession(content, hash) {
    this.contentEl.empty();
    this.contentEl.addClass("anky-file-view");
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
    const topBar = this.contentEl.createDiv({ cls: "anky-file-top-bar" });
    const leftButtons = topBar.createDiv({ cls: "anky-file-left-buttons" });
    const mapBtn = leftButtons.createEl("button", { cls: "anky-btn-outline" });
    mapBtn.textContent = "Map";
    mapBtn.addEventListener("click", () => {
      void this.openMapView();
    });
    const statsRow = leftButtons.createDiv({ cls: "anky-stats-row" });
    const rightButtons = topBar.createDiv({ cls: "anky-file-right-buttons" });
    const infoBtn = rightButtons.createEl("button", { cls: "anky-btn-info-small" });
    infoBtn.textContent = "\u24D8";
    infoBtn.addEventListener("click", () => {
      new AnkyInfoModal(this.app).open();
    });
    const deleteBtn = rightButtons.createEl("button", { cls: "anky-btn-delete" });
    deleteBtn.textContent = "Delete session";
    deleteBtn.addEventListener("click", () => {
      const file = this.file;
      if (!file)
        return;
      const modal = new AnkyConfirmModal(this.app, "Delete this session?");
      modal.open();
      void modal.waitForResult().then((confirmed) => __async(this, null, function* () {
        if (!confirmed)
          return;
        yield this.app.fileManager.trashFile(file);
        window.history.back();
      }));
    });
    const addStat = (value, label) => {
      const s = statsRow.createDiv({ cls: "anky-stat" });
      const n = s.createDiv({ cls: "anky-stat-value" });
      n.textContent = value;
      const l = s.createDiv({ cls: "anky-stat-label" });
      l.textContent = label;
    };
    addStat(
      date.toLocaleDateString("en", { month: "short", day: "numeric" }),
      "Date"
    );
    addStat(duration, "Duration");
    addStat(String(words), "Words");
    addStat(flowScore + "%", "Flow");
    const textPanel = this.contentEl.createDiv({ cls: "anky-text-panel" });
    const body = textPanel.createDiv({ cls: "anky-text-body" });
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
    return "Anky map";
  }
  getIcon() {
    return "map";
  }
  onOpen() {
    return __async(this, null, function* () {
      yield this.renderMap();
      this.keyHandler = (e) => {
        this.handleKey(e);
      };
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
        void this.app.workspace.openLinkText(this.sessions[this.selectedIndex].path, "", false);
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
      old.removeClass("anky-map-cell--selected");
      old.addClass("anky-map-cell--deselected");
    }
    this.selectedIndex = index;
    const cell = this.cells[index];
    cell.removeClass("anky-map-cell--deselected");
    cell.addClass("anky-map-cell--selected");
    cell.scrollIntoView({ block: "nearest" });
    this.updateInfo(this.sessions[index]);
    this.updatePreview(this.sessions[index]);
  }
  updateInfo(session) {
    if (!this.infoEl)
      return;
    this.infoEl.empty();
    const durationMin = Math.floor(session.durationMs / 6e4);
    const durationSec = Math.floor(session.durationMs % 6e4 / 1e3);
    const dateStr = session.date.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
    const dur = `${durationMin}:${durationSec.toString().padStart(2, "0")}`;
    const typeLabel = this.infoEl.createSpan({ cls: session.isAnky ? "anky-map-info-anky-label" : "anky-map-info-session-label" });
    typeLabel.textContent = session.isAnky ? "Anky" : "Session";
    this.infoEl.appendText(` \xB7 ${dateStr} \xB7 ${dur} \xB7 ${session.words} words  `);
    const openHint = this.infoEl.createSpan({ cls: "anky-map-info-open-hint" });
    openHint.textContent = "Space to open";
  }
  updatePreview(session) {
    if (!this.previewEl)
      return;
    this.previewEl.empty();
    const dateStr = session.date.toLocaleDateString("en", { month: "short", day: "numeric" });
    const durationMin = Math.floor(session.durationMs / 6e4);
    const durationSec = Math.floor(session.durationMs % 6e4 / 1e3);
    const dur = `${durationMin}:${durationSec.toString().padStart(2, "0")}`;
    const header = this.previewEl.createDiv({ cls: "anky-preview-header" });
    const dateSpan = header.createSpan({ cls: "anky-preview-date" });
    dateSpan.textContent = dateStr;
    const durSpan = header.createSpan();
    durSpan.textContent = dur;
    const wordsSpan = header.createSpan();
    wordsSpan.textContent = `${session.words} words`;
    const typeSpan = header.createSpan({ cls: session.isAnky ? "anky-map-info-anky-label" : "" });
    typeSpan.textContent = session.isAnky ? "Anky" : "Session";
    const textEl = this.previewEl.createDiv({ cls: "anky-preview-text" });
    textEl.textContent = session.text;
  }
  renderMap() {
    return __async(this, null, function* () {
      this.contentEl.empty();
      this.cells = [];
      this.selectedIndex = -1;
      this.contentEl.addClass("anky-map-view");
      const header = this.contentEl.createDiv({ cls: "anky-map-header" });
      const title = header.createDiv({ cls: "anky-map-title" });
      title.textContent = "Anky map";
      this.sessions = yield this.scanSessions();
      const totalCount = this.sessions.length;
      const ankyCount = this.sessions.filter((s) => s.isAnky).length;
      const summaryEl = header.createDiv({ cls: "anky-map-summary" });
      const totalEl = summaryEl.createDiv();
      const totalNum = totalEl.createSpan({ cls: "anky-map-summary-total" });
      totalNum.textContent = String(totalCount);
      totalEl.appendText(" sessions");
      const ankyEl = summaryEl.createDiv();
      const ankyNum = ankyEl.createSpan({ cls: "anky-map-summary-anky" });
      ankyNum.textContent = String(ankyCount);
      ankyEl.appendText(" ankys");
      const mainLayout = this.contentEl.createDiv({ cls: "anky-map-main" });
      const leftPanel = mainLayout.createDiv({ cls: "anky-map-left" });
      const legend = leftPanel.createDiv({ cls: "anky-map-legend" });
      const addLegendItem = (dotCls, label) => {
        const item = legend.createDiv({ cls: "anky-legend-item" });
        item.createDiv({ cls: `anky-legend-dot ${dotCls}` });
        const text = item.createDiv();
        text.textContent = label;
      };
      addLegendItem("anky-legend-dot--anky", "Anky (8+ min)");
      addLegendItem("anky-legend-dot--session", "Session (< 8 min)");
      this.infoEl = leftPanel.createDiv({ cls: "anky-map-info" });
      const hintSpan = this.infoEl.createSpan({ cls: "anky-map-info-hint" });
      hintSpan.textContent = "Arrow keys to navigate, space to open";
      this.sessions.sort((a, b) => a.date.getTime() - b.date.getTime());
      const grid = leftPanel.createDiv({ cls: "anky-map-grid" });
      for (let i = 0; i < this.sessions.length; i++) {
        const session = this.sessions[i];
        const cellCls = session.isAnky ? "anky-map-cell anky-map-cell--anky" : "anky-map-cell anky-map-cell--session";
        const cell = grid.createDiv({ cls: cellCls });
        const idx = i;
        cell.addEventListener("mouseenter", () => {
          this.selectCell(idx);
        });
        cell.addEventListener("mouseleave", () => {
          if (this.selectedIndex === idx) {
            cell.removeClass("anky-map-cell--selected");
            cell.addClass("anky-map-cell--deselected");
          }
        });
        cell.addEventListener("click", () => {
          void this.app.workspace.openLinkText(session.path, "", false);
        });
        this.cells.push(cell);
      }
      if (this.sessions.length === 0) {
        const empty = leftPanel.createDiv({ cls: "anky-map-empty" });
        empty.textContent = "No sessions yet. Start writing!";
      }
      this.previewEl = mainLayout.createDiv({ cls: "anky-map-right" });
      const previewHint = this.previewEl.createDiv({ cls: "anky-map-preview-hint" });
      previewHint.textContent = "Select a session to preview";
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
        id: "start-session",
        name: "Start writing session",
        callback: () => {
          new AnkyWritingModal(this.app, this).open();
        }
      });
      this.addCommand({
        id: "open-map",
        name: "Open map",
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
