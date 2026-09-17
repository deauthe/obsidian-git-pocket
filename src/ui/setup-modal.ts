import { App, Modal, Notice } from "obsidian";

export interface SetupState {
  signedIn: boolean;
  repoPicked: boolean;
  repoInitialised: boolean;
}

interface AppSettingLike {
  open(): void;
  openTabById(id: string): unknown;
}

/**
 * Shown instead of refusing an action, because "sign in first" with no way to
 * sign in is what the plugin used to do and it is a dead end — especially on a
 * phone, where the settings tab is several taps away and not obviously related
 * to the button that just failed.
 */
export class SetupModal extends Modal {
  constructor(
    app: App,
    private state: SetupState,
    private onOpenSettings: () => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("git-pocket-modal");
    contentEl.createEl("h2", { text: "Git Pocket needs setting up" });
    contentEl.createEl("p", {
      cls: "git-pocket-sub",
      text: "Finish these and every Git Pocket command works. Nothing is uploaded until you sync.",
    });

    const steps = contentEl.createDiv({ cls: "git-pocket-steps" });
    this.step(steps, this.state.signedIn, "Sign in to GitHub", "Paste a fine-grained token.");
    this.step(steps, this.state.repoPicked, "Pick a repository", "Where this vault pushes to.");
    this.step(
      steps,
      this.state.repoInitialised,
      "Initialise the repository",
      "Creates .git inside the vault if it is not one already.",
    );

    const actions = contentEl.createDiv({ cls: "git-pocket-actions" });
    const later = actions.createEl("button", { text: "Not now" });
    later.onclick = () => this.close();
    const go = actions.createEl("button", { text: "Open Git Pocket settings", cls: "mod-cta" });
    go.onclick = () => {
      this.close();
      this.onOpenSettings();
    };
  }

  private step(parent: HTMLElement, done: boolean, name: string, desc: string) {
    const row = parent.createDiv({ cls: `git-pocket-step ${done ? "is-done" : "is-todo"}` });
    row.createSpan({ cls: "git-pocket-step-mark", text: done ? "✓" : "•" });
    const body = row.createDiv({ cls: "git-pocket-step-body" });
    body.createDiv({ cls: "git-pocket-step-name", text: name });
    body.createDiv({ cls: "git-pocket-meta", text: desc });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Obsidian exposes no public way to open a specific settings tab. */
export function openPluginSettings(app: App, pluginId: string): void {
  const setting = (app as unknown as { setting?: AppSettingLike }).setting;
  try {
    if (!setting?.open || !setting.openTabById) throw new Error("unavailable");
    setting.open();
    setting.openTabById(pluginId);
  } catch {
    new Notice("Open Settings → Community plugins → Git Pocket.", 6000);
  }
}
