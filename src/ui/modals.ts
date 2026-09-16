import { App, FuzzySuggestModal, Modal, Notice } from "obsidian";
import type { RepoSummary } from "../github";
import type { ChangedFile } from "../git";

export class RepoPickerModal extends FuzzySuggestModal<RepoSummary> {
  constructor(
    app: App,
    private repos: RepoSummary[],
    private onPick: (repo: RepoSummary) => void,
  ) {
    super(app);
    this.setPlaceholder("Search your repositories…");
  }
  getItems() { return this.repos; }
  getItemText(r: RepoSummary) { return r.fullName; }
  onChooseItem(r: RepoSummary) { this.onPick(r); }
}

export class TextPromptModal extends Modal {
  private value: string;
  constructor(
    app: App,
    private title: string,
    private description: string,
    initial: string,
    private cta: string,
    private onSubmit: (value: string) => void,
  ) {
    super(app);
    this.value = initial;
  }
  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("git-pocket-modal");
    contentEl.createEl("h2", { text: this.title });
    if (this.description) contentEl.createEl("p", { cls: "git-pocket-sub", text: this.description });

    const input = contentEl.createEl("textarea", { cls: "git-pocket-textarea" });
    input.value = this.value;
    input.rows = 3;
    input.oninput = () => (this.value = input.value);
    input.onkeydown = (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.finish();
      }
    };
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 20);

    const actions = contentEl.createDiv({ cls: "git-pocket-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const ok = actions.createEl("button", { text: this.cta, cls: "mod-cta" });
    ok.onclick = () => this.finish();
  }
  private finish() {
    const v = this.value.trim();
    if (!v) {
      new Notice("A commit message is required.");
      return;
    }
    this.close();
    this.onSubmit(v);
  }
  onClose() { this.contentEl.empty(); }
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private body: string,
    private cta: string,
    private onConfirm: () => void,
    private secondary?: { label: string; run: () => void },
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("git-pocket-modal");
    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", { cls: "git-pocket-sub", text: this.body });
    const actions = contentEl.createDiv({ cls: "git-pocket-actions" });
    const cancel = actions.createEl("button", { text: "Not now" });
    cancel.onclick = () => this.close();
    if (this.secondary) {
      const s = actions.createEl("button", { text: this.secondary.label });
      s.onclick = () => {
        this.close();
        this.secondary?.run();
      };
    }
    const ok = actions.createEl("button", { text: this.cta, cls: "mod-cta" });
    ok.onclick = () => {
      this.close();
      this.onConfirm();
    };
  }
  onClose() { this.contentEl.empty(); }
}

/** Shown on a long-press / explicit command: what is about to be committed. */
export class ChangesModal extends Modal {
  constructor(
    app: App,
    private files: ChangedFile[],
    private onCommit: () => void,
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("git-pocket-modal");
    contentEl.createEl("h2", { text: `${this.files.length} changed file(s)` });
    const list = contentEl.createDiv({ cls: "git-pocket-filelist" });
    for (const f of this.files.slice(0, 300)) {
      const row = list.createDiv({ cls: `git-pocket-file is-${f.state}` });
      row.createSpan({ cls: "git-pocket-file-badge", text: f.state[0].toUpperCase() });
      row.createSpan({ cls: "git-pocket-file-path", text: f.path });
    }
    if (this.files.length > 300) {
      list.createDiv({ cls: "git-pocket-meta", text: `…and ${this.files.length - 300} more` });
    }
    const actions = contentEl.createDiv({ cls: "git-pocket-actions" });
    const close = actions.createEl("button", { text: "Close" });
    close.onclick = () => this.close();
    const commit = actions.createEl("button", { text: "Commit all", cls: "mod-cta" });
    commit.onclick = () => {
      this.close();
      this.onCommit();
    };
  }
  onClose() { this.contentEl.empty(); }
}

export class DeviceCodeModal extends Modal {
  constructor(
    app: App,
    private userCode: string,
    private url: string,
    private cancelSignal: { cancelled: boolean },
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("git-pocket-modal");
    contentEl.createEl("h2", { text: "Sign in to GitHub" });
    contentEl.createEl("p", { cls: "git-pocket-sub", text: "Enter this code on GitHub. This window closes itself once you approve." });

    const code = contentEl.createDiv({ cls: "git-pocket-devicecode", text: this.userCode });
    code.onclick = async () => {
      await navigator.clipboard.writeText(this.userCode);
      new Notice("Code copied.");
    };

    const actions = contentEl.createDiv({ cls: "git-pocket-actions" });
    const copy = actions.createEl("button", { text: "Copy code" });
    copy.onclick = async () => {
      await navigator.clipboard.writeText(this.userCode);
      new Notice("Code copied.");
    };
    const open = actions.createEl("button", { text: "Open GitHub", cls: "mod-cta" });
    open.onclick = () => window.open(this.url, "_blank");
  }
  onClose() {
    this.cancelSignal.cancelled = true;
    this.contentEl.empty();
  }
}
