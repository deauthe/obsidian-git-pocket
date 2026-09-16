import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type GitPocketPlugin from "./main";
import {
  listRepos,
  newTokenUrl,
  pollDeviceFlow,
  startDeviceFlow,
  verifyToken,
} from "./github";
import { ConfirmModal, DeviceCodeModal, RepoPickerModal } from "./ui/modals";

interface AppSettingLike {
  open(): void;
  openTabById(id: string): {
    searchComponent?: { inputEl: HTMLInputElement };
    updateHotkeyVisibility?: () => void;
  } | undefined;
}

const STARTER_GITIGNORE = `# Git Pocket starter
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash/
.DS_Store
`;

export class GitPocketSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GitPocketPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("git-pocket-settings");

    this.account(containerEl);
    this.repository(containerEl);
    this.committing(containerEl);
    this.syncing(containerEl);
    this.advanced(containerEl);
  }

  /* ------------------------------- account ------------------------------- */

  private account(root: HTMLElement) {
    new Setting(root).setName("GitHub").setHeading();
    const s = this.plugin.settings;

    if (s.token && s.githubLogin) {
      new Setting(root)
        .setName("Signed in")
        .setDesc(`@${s.githubLogin} · ${s.tokenKind === "oauth" ? "OAuth" : "personal access token"}`)
        .addButton((b) =>
          b.setButtonText("Sign out").setWarning().onClick(async () => {
            s.token = "";
            s.githubLogin = "";
            s.tokenKind = "";
            await this.plugin.saveSettings();
            this.display();
          }),
        );
      return;
    }

    new Setting(root)
      .setName("Sign in with a token")
      .setDesc(
        "The one-tap path, and the only one that needs no setup. Opens GitHub's token page — give it Contents: read & write on the repo you want, then paste the token below.",
      )
      .addButton((b) =>
        b.setButtonText("Open GitHub").setCta().onClick(() => window.open(newTokenUrl(), "_blank")),
      );

    let pasted = "";
    new Setting(root)
      .setName("Paste token")
      .addText((t) =>
        t
          .setPlaceholder("github_pat_… or ghp_…")
          .onChange((v) => (pasted = v.trim()))
          .then((t) => (t.inputEl.type = "password")),
      )
      .addButton((b) =>
        b.setButtonText("Save").onClick(async () => {
          if (!pasted) {
            new Notice("Paste a token first.");
            return;
          }
          await this.acceptToken(pasted, "pat");
        }),
      );

    if (s.oauthClientId) {
      new Setting(root)
        .setName("Sign in with GitHub")
        .setDesc("Device login using the OAuth app configured under Advanced.")
        .addButton((b) =>
          b.setButtonText("Start").onClick(async () => {
            try {
              const code = await startDeviceFlow(s.oauthClientId);
              const signal = { cancelled: false };
              const modal = new DeviceCodeModal(
                this.app,
                code.user_code,
                code.verification_uri,
                signal,
              );
              modal.open();
              const token = await pollDeviceFlow(s.oauthClientId, code, signal);
              modal.close();
              await this.acceptToken(token, "oauth");
            } catch (e) {
              new Notice(e instanceof Error ? e.message : String(e), 8000);
            }
          }),
        );
    }
  }

  private async acceptToken(token: string, kind: "pat" | "oauth") {
    try {
      const user = await verifyToken(token);
      const s = this.plugin.settings;
      s.token = token;
      s.tokenKind = kind;
      s.githubLogin = user.login;
      if (!s.authorName) s.authorName = user.login;
      if (!s.authorEmail) s.authorEmail = user.email;
      await this.plugin.saveSettings();
      new Notice(`Signed in as @${user.login}.`);
      this.display();
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e), 8000);
    }
  }

  /* ------------------------------ repository ----------------------------- */

  private repository(root: HTMLElement) {
    new Setting(root).setName("Repository").setHeading();
    const s = this.plugin.settings;

    new Setting(root)
      .setName("Repository")
      .setDesc(s.repo || "None selected. This vault pushes to whichever repo you pick here.")
      .addButton((b) =>
        b
          .setButtonText(s.repo ? "Change" : "Choose…")
          .setCta()
          .onClick(async () => {
            if (!s.token) {
              new Notice("Sign in first.");
              return;
            }
            try {
              const repos = await listRepos(s.token);
              if (repos.length === 0) {
                new Notice("That token can't see any repository you can push to.");
                return;
              }
              new RepoPickerModal(this.app, repos, (repo) => {
                void (async () => {
                  s.repo = repo.fullName;
                  s.branch = repo.defaultBranch || "main";
                  await this.plugin.saveSettings();
                  await this.wireRemote();
                  this.display();
                })();
              }).open();
            } catch (e) {
              new Notice(e instanceof Error ? e.message : String(e), 8000);
            }
          }),
      );

    new Setting(root)
      .setName("Branch")
      .setDesc("The branch this vault commits to and syncs with.")
      .addText((t) =>
        t.setValue(s.branch).onChange(async (v) => {
          s.branch = v.trim() || "main";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Local repository")
      .setDesc("Whether this vault folder is a git repository yet.")
      .addButton((b) =>
        b.setButtonText("Check / set up").onClick(async () => {
          const has = await this.plugin.git.hasGitDir();
          if (has) {
            await this.wireRemote();
            new Notice("Repository ready.");
            return;
          }
          new ConfirmModal(
            this.app,
            "Initialise a repository here?",
            `This creates a .git folder inside your vault and points it at ${s.repo || "the chosen repo"}. Nothing is uploaded until you sync. If the remote already has files, pull before your first push.`,
            "Initialise",
            () => {
              void (async () => {
                try {
                  await this.plugin.git.init(s.branch);
                  await this.wireRemote();
                  new Notice("Repository initialised.");
                } catch (e) {
                  new Notice(e instanceof Error ? e.message : String(e), 8000);
                }
              })();
            },
          ).open();
        }),
      );

    new Setting(root)
      .setName("Starter .gitignore")
      .setDesc(
        "Keeps Obsidian's per-device workspace files out of git, which is the single biggest source of phone-vs-desktop conflicts.",
      )
      .addButton((b) =>
        b.setButtonText("Write .gitignore").onClick(async () => {
          const existing = await this.plugin.git.readGitignore();
          if (existing) {
            new Notice("A .gitignore already exists — leaving it alone.");
            return;
          }
          await this.plugin.git.writeGitignore(STARTER_GITIGNORE);
          new Notice("Wrote .gitignore.");
        }),
      );
  }

  private async wireRemote() {
    const s = this.plugin.settings;
    if (!s.repo) return;
    if (!(await this.plugin.git.hasGitDir())) return;
    await this.plugin.git.setRemote(s.remote, `https://github.com/${s.repo}.git`);
  }

  /* ------------------------------ committing ----------------------------- */

  private committing(root: HTMLElement) {
    new Setting(root).setName("Committing").setHeading();
    const s = this.plugin.settings;

    new Setting(root)
      .setName("Default commit message")
      .setDesc(
        "Used by the commit and sync shortcuts. Placeholders: {{date}} {{time}} {{count}} {{files}} {{file}} {{device}}",
      )
      .addTextArea((t) =>
        t.setValue(s.defaultCommitMessage).onChange(async (v) => {
          s.defaultCommitMessage = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Shortcuts")
      .setDesc(
        "Commit is Cmd/Ctrl+Shift+C and sync is Cmd/Ctrl+Shift+S by default. Rebind them wherever you like.",
      )
      .addButton((b) =>
        b.setButtonText("Open hotkeys").onClick(() => {
          // Obsidian exposes no public API for opening a settings tab, so this
          // reaches a private one and degrades to an instruction if it moves.
          const setting = (this.app as unknown as { setting?: AppSettingLike }).setting;
          try {
            if (!setting?.open || !setting.openTabById) throw new Error("unavailable");
            setting.open();
            const tab = setting.openTabById("hotkeys");
            if (tab?.searchComponent) {
              tab.searchComponent.inputEl.value = "Git Pocket";
              tab.updateHotkeyVisibility?.();
            }
          } catch {
            new Notice('Open Settings \u2192 Hotkeys and search for "Git Pocket".', 6000);
          }
        }),
      );

    new Setting(root)
      .setName("Author name")
      .addText((t) =>
        t.setPlaceholder(s.githubLogin || "Obsidian").setValue(s.authorName).onChange(async (v) => {
          s.authorName = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Author email")
      .addText((t) =>
        t.setValue(s.authorEmail).onChange(async (v) => {
          s.authorEmail = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Device label")
      .setDesc("Fills {{device}}. Leave blank to auto-detect (iphone / android / desktop).")
      .addText((t) =>
        t.setPlaceholder(this.plugin.deviceName()).setValue(s.deviceName).onChange(async (v) => {
          s.deviceName = v.trim();
          await this.plugin.saveSettings();
        }),
      );
  }

  /* ------------------------------- syncing ------------------------------- */

  private syncing(root: HTMLElement) {
    new Setting(root).setName("Syncing").setHeading();
    const s = this.plugin.settings;

    new Setting(root)
      .setName("Check the remote on startup")
      .setDesc("If the remote branch is ahead, offer to pull before you start editing.")
      .addToggle((t) =>
        t.setValue(s.pullOnStartup).onChange(async (v) => {
          s.pullOnStartup = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Pull without asking when it fast-forwards")
      .setDesc("Skips the prompt in the only case that can't produce a merge — you have no local commits.")
      .addToggle((t) =>
        t.setValue(s.pullOnStartupSilent).onChange(async (v) => {
          s.pullOnStartupSilent = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Offer to squash before pushing")
      .setDesc("Shows the tidy-up sheet whenever a sync would push more than one commit.")
      .addToggle((t) =>
        t.setValue(s.squashBeforePush).onChange(async (v) => {
          s.squashBeforePush = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Pre-select whole days in the squash sheet")
      .setDesc("Every day with more than one commit starts selected, so one tap collapses the lot.")
      .addToggle((t) =>
        t.setValue(s.squashSelectDaysByDefault).onChange(async (v) => {
          s.squashSelectDaysByDefault = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Auto-sync every N minutes")
      .setDesc("0 disables it. Auto-syncs never open the squash sheet — they just push.")
      .addSlider((sl) =>
        sl
          .setLimits(0, 60, 5)
          .setValue(s.autoSyncMinutes)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.autoSyncMinutes = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName("Sync when Obsidian loses focus")
      .setDesc("On a phone this is the moment you switch apps — the most reliable time to catch a change.")
      .addToggle((t) =>
        t.setValue(s.syncOnBlur).onChange(async (v) => {
          s.syncOnBlur = v;
          await this.plugin.saveSettings();
          new Notice("Restart Obsidian for this to take effect.");
        }),
      );

    new Setting(root)
      .setName("Show status bar item")
      .addToggle((t) =>
        t.setValue(s.showStatusBar).onChange(async (v) => {
          s.showStatusBar = v;
          await this.plugin.saveSettings();
          new Notice("Restart Obsidian for this to take effect.");
        }),
      );
  }

  /* ------------------------------- advanced ------------------------------ */

  private advanced(root: HTMLElement) {
    new Setting(root).setName("Advanced").setHeading();
    const s = this.plugin.settings;

    new Setting(root)
      .setName("Remote name")
      .addText((t) =>
        t.setValue(s.remote).onChange(async (v) => {
          s.remote = v.trim() || "origin";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("OAuth app client ID")
      .setDesc(
        "Optional. Set this to your own GitHub OAuth app to get the 'Sign in with GitHub' device-code flow instead of pasting a token.",
      )
      .addText((t) =>
        t.setValue(s.oauthClientId).onChange(async (v) => {
          s.oauthClientId = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    const warn = root.createDiv({ cls: "git-pocket-warning" });
    warn.setText(
      "Your token is stored in this vault's plugin data, unencrypted — the same place every Obsidian plugin keeps its settings. Use a fine-grained token scoped to this one repository, so a leaked vault costs you that repo and nothing else.",
    );
  }
}
