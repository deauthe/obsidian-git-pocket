import {
  App,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
} from "obsidian";
import type GitPocketPlugin from "./main";
import type { GitPocketSettings } from "./settings";
import {
  listRepos,
  newTokenUrl,
  pollDeviceFlow,
  startDeviceFlow,
  verifyToken,
} from "./github";
import { ConfirmModal, DeviceCodeModal, RepoPickerModal } from "./ui/modals";

type Key = keyof GitPocketSettings;

interface AppSettingLike {
  open(): void;
  openTabById(id: string):
    | { searchComponent?: { inputEl: HTMLInputElement }; updateHotkeyVisibility?: () => void }
    | undefined;
}

const STARTER_GITIGNORE = `# Git Pocket starter
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash/
.DS_Store
`;

/** Asks for a GitHub token without ever putting it in a persisted settings field. */
class TokenModal extends Modal {
  private value = "";
  constructor(app: App, private onSubmit: (token: string) => void) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("git-pocket-modal");
    contentEl.createEl("h2", { text: "Sign in to GitHub" });
    contentEl.createEl("p", {
      cls: "git-pocket-sub",
      text: "Create a fine-grained token with Contents: read & write on the repository you want, then paste it here.",
    });

    const open = contentEl.createEl("button", { text: "Open GitHub token page", cls: "mod-cta" });
    open.onclick = () => window.open(newTokenUrl(), "_blank");

    const input = contentEl.createEl("input", { type: "password", cls: "git-pocket-token" });
    input.placeholder = "github_pat_… or ghp_…";
    input.oninput = () => (this.value = input.value.trim());
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.finish();
      }
    };

    const actions = contentEl.createDiv({ cls: "git-pocket-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const save = actions.createEl("button", { text: "Sign in", cls: "mod-cta" });
    save.onclick = () => this.finish();
  }
  private finish() {
    if (!this.value) {
      new Notice("Paste a token first.");
      return;
    }
    const token = this.value;
    this.close();
    this.onSubmit(token);
  }
  onClose() {
    this.contentEl.empty();
  }
}

export class GitPocketSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GitPocketPlugin) {
    super(app, plugin);
  }

  /**
   * Obsidian 1.13 renders the tab from these definitions and indexes them for
   * settings search. `display()` is deliberately not implemented: it is only
   * reached when this returns an empty array, and carrying both would be two
   * copies of the same UI with nothing keeping them in step.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.accountGroup(),
      this.repositoryGroup(),
      this.committingGroup(),
      this.syncingGroup(),
      this.advancedGroup(),
    ];
  }

  // Control rows read and write plugin settings by key; every write goes through
  // saveSettings(), which is also what restarts the auto-sync timer.
  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
  }

  /* ------------------------------- account ------------------------------- */

  private accountGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    const signedIn = s.token.length > 0 && s.githubLogin.length > 0;

    return {
      type: "group",
      heading: "GitHub",
      items: [
        {
          name: "Signed in",
          desc: signedIn
            ? `@${s.githubLogin} · ${s.tokenKind === "oauth" ? "OAuth" : "personal access token"}. Select to sign out.`
            : "",
          visible: () => signedIn,
          action: () => {
            void (async () => {
              s.token = "";
              s.githubLogin = "";
              s.tokenKind = "";
              await this.plugin.saveSettings();
              this.update();
            })();
          },
        },
        {
          name: "Sign in with a token",
          desc: "The path that needs no setup: one tap to GitHub's token page, then paste it back.",
          visible: () => !signedIn,
          action: () => {
            new TokenModal(this.app, (token) => void this.acceptToken(token, "pat")).open();
          },
        },
        {
          name: "Sign in with GitHub",
          desc: "Device login using the OAuth app configured under Advanced.",
          visible: () => !signedIn && s.oauthClientId.length > 0,
          action: () => void this.deviceLogin(),
        },
      ],
    };
  }

  private async deviceLogin() {
    const s = this.plugin.settings;
    try {
      const code = await startDeviceFlow(s.oauthClientId);
      const signal = { cancelled: false };
      const modal = new DeviceCodeModal(this.app, code.user_code, code.verification_uri, signal);
      modal.open();
      const token = await pollDeviceFlow(s.oauthClientId, code, signal);
      modal.close();
      await this.acceptToken(token, "oauth");
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e), 8000);
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
      this.update();
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e), 8000);
    }
  }

  /* ------------------------------ repository ----------------------------- */

  private repositoryGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;

    return {
      type: "group",
      heading: "Repository",
      items: [
        {
          name: "Repository",
          desc: s.repo || "None selected. This vault pushes to whichever repository you pick here.",
          disabled: () => this.plugin.settings.token.length === 0,
          action: () => void this.pickRepo(),
        },
        {
          name: "Branch",
          desc: "The branch this vault commits to and syncs with.",
          control: { type: "text", key: "branch" satisfies Key, defaultValue: "main" },
        },
        {
          name: "Local repository",
          desc: "Check whether this vault folder is a git repository, and set it up if it is not.",
          action: () => void this.ensureRepo(),
        },
        {
          name: "Starter .gitignore",
          desc: "Keeps Obsidian's per-device workspace files out of git — the single biggest source of phone-versus-desktop conflicts.",
          action: () => void this.writeGitignore(),
        },
      ],
    };
  }

  private async pickRepo() {
    const s = this.plugin.settings;
    if (!s.token) {
      new Notice("Sign in first.");
      return;
    }
    try {
      const repos = await listRepos(s.token);
      if (repos.length === 0) {
        new Notice("That token cannot see any repository you can push to.");
        return;
      }
      new RepoPickerModal(this.app, repos, (repo) => {
        void (async () => {
          s.repo = repo.fullName;
          s.branch = repo.defaultBranch || "main";
          await this.plugin.saveSettings();
          await this.wireRemote();
          this.update();
        })();
      }).open();
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e), 8000);
    }
  }

  private async ensureRepo() {
    const s = this.plugin.settings;
    if (await this.plugin.git.hasGitDir()) {
      await this.wireRemote();
      new Notice("Repository ready.");
      return;
    }
    new ConfirmModal(
      this.app,
      "Initialise a repository here?",
      `This creates a .git folder inside your vault and points it at ${s.repo || "the chosen repository"}. Nothing is uploaded until you sync. If the remote already has files, pull before your first push.`,
      "Initialise",
      () => {
        void (async () => {
          try {
            await this.plugin.git.init(s.branch);
            await this.wireRemote();
            new Notice("Repository initialised.");
            this.update();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e), 8000);
          }
        })();
      },
    ).open();
  }

  private async writeGitignore() {
    const existing = await this.plugin.git.readGitignore();
    if (existing) {
      new Notice("A .gitignore already exists — leaving it alone.");
      return;
    }
    await this.plugin.git.writeGitignore(STARTER_GITIGNORE);
    new Notice("Wrote .gitignore.");
  }

  private async wireRemote() {
    const s = this.plugin.settings;
    if (!s.repo) return;
    if (!(await this.plugin.git.hasGitDir())) return;
    await this.plugin.git.setRemote(s.remote, `https://github.com/${s.repo}.git`);
  }

  /* ------------------------------ committing ----------------------------- */

  private committingGroup(): SettingDefinitionItem {
    return {
      type: "group",
      heading: "Committing",
      items: [
        {
          name: "Default commit message",
          desc: "Used by the commit and sync commands. Placeholders: {{date}} {{time}} {{count}} {{files}} {{file}} {{device}}",
          control: {
            type: "textarea",
            key: "defaultCommitMessage" satisfies Key,
            rows: 2,
          },
        },
        {
          name: "Shortcuts",
          desc: "Git Pocket ships no default hotkeys, so it can never collide with yours. Bind Commit and Sync here.",
          action: () => this.openHotkeys(),
        },
        {
          name: "Author name",
          desc: "Name recorded on commits made from this vault.",
          control: {
            type: "text",
            key: "authorName" satisfies Key,
            placeholder: this.plugin.settings.githubLogin || "Obsidian",
          },
        },
        {
          name: "Author email",
          desc: "Email recorded on commits. GitHub attributes commits by this address.",
          control: { type: "text", key: "authorEmail" satisfies Key },
        },
        {
          name: "Device label",
          desc: "Fills {{device}}. Leave blank to detect it automatically.",
          control: {
            type: "text",
            key: "deviceName" satisfies Key,
            placeholder: this.plugin.deviceName(),
          },
        },
      ],
    };
  }

  private openHotkeys() {
    // Obsidian exposes no public API for opening a settings tab, so this reaches
    // a private one and degrades to an instruction if it moves.
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
      new Notice('Open Settings → Hotkeys and search for "Git Pocket".', 6000);
    }
  }

  /* ------------------------------- syncing ------------------------------- */

  private syncingGroup(): SettingDefinitionItem {
    return {
      type: "group",
      heading: "Syncing",
      items: [
        {
          name: "Check the remote on startup",
          desc: "If the remote branch is ahead, offer to pull before you start editing.",
          control: { type: "toggle", key: "pullOnStartup" satisfies Key },
        },
        {
          name: "Pull without asking when it fast-forwards",
          desc: "Skips the prompt in the only case that cannot produce a merge — you have no local commits.",
          control: {
            type: "toggle",
            key: "pullOnStartupSilent" satisfies Key,
            disabled: () => !this.plugin.settings.pullOnStartup,
          },
        },
        {
          name: "Offer to squash before pushing",
          desc: "Shows the tidy-up sheet whenever a sync would push more than one commit.",
          control: { type: "toggle", key: "squashBeforePush" satisfies Key },
        },
        {
          name: "Pre-select whole days in the squash sheet",
          desc: "Every day with more than one commit starts selected, so one tap collapses the lot.",
          control: {
            type: "toggle",
            key: "squashSelectDaysByDefault" satisfies Key,
            disabled: () => !this.plugin.settings.squashBeforePush,
          },
        },
        {
          name: "Auto-sync",
          desc: "Automatic syncs never open the squash sheet; they commit and push.",
          control: {
            type: "slider",
            key: "autoSyncMinutes" satisfies Key,
            min: 0,
            max: 60,
            step: 5,
            displayFormat: (v) => (v === 0 ? "Off" : `Every ${v} min`),
          },
        },
        {
          name: "Sync when Obsidian loses focus",
          desc: "On a phone this is the moment you switch apps — the most reliable time to catch a change. Takes effect after a restart.",
          control: { type: "toggle", key: "syncOnBlur" satisfies Key },
        },
        {
          name: "Show status bar item",
          desc: "Shows changed-file, ahead and behind counts. Takes effect after a restart.",
          control: { type: "toggle", key: "showStatusBar" satisfies Key },
        },
      ],
    };
  }

  /* ------------------------------- advanced ------------------------------ */

  private advancedGroup(): SettingDefinitionItem {
    return {
      type: "group",
      heading: "Advanced",
      items: [
        {
          name: "Remote name",
          desc: "The git remote this vault pushes to.",
          control: { type: "text", key: "remote" satisfies Key, defaultValue: "origin" },
        },
        {
          name: "OAuth app client ID",
          desc: "Optional. Set this to your own GitHub OAuth app to get device-code sign-in instead of pasting a token.",
          control: { type: "text", key: "oauthClientId" satisfies Key },
        },
        {
          name: "Where your token is stored",
          searchable: false,
          render: (setting: Setting) => {
            setting.settingEl.addClass("git-pocket-warning-row");
            setting.setDesc(
              "Your token lives in this vault's plugin data, unencrypted — the same place every Obsidian plugin keeps its settings. Use a fine-grained token scoped to the one repository, so a leaked vault costs you that repository and nothing else.",
            );
          },
        },
      ],
    };
  }
}
