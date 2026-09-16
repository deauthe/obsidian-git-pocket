import { Notice, Platform, Plugin, addIcon, debounce } from "obsidian";
import { DEFAULT_SETTINGS, GitPocketSettings, renderTemplate } from "./settings";
import { GitPocketSettingTab } from "./settings-tab";
import { GitService, type CommitRow } from "./git";
import { SquashModal } from "./ui/squash-modal";
import { ChangesModal, ConfirmModal, TextPromptModal } from "./ui/modals";

export default class GitPocketPlugin extends Plugin {
  settings!: GitPocketSettings;
  git!: GitService;

  private statusBar: HTMLElement | null = null;
  private busy = false;
  private autoSyncTimer: number | null = null;

  async onload() {
    await this.loadSettings();

    this.git = new GitService(
      this.app.vault.adapter,
      () => ({ token: this.settings.token, login: this.settings.githubLogin }),
      () => ({
        name: this.settings.authorName || this.settings.githubLogin || "Obsidian",
        email:
          this.settings.authorEmail ||
          `${this.settings.githubLogin || "obsidian"}@users.noreply.github.com`,
      }),
    );

    this.addSettingTab(new GitPocketSettingTab(this.app, this));
    this.registerCommands();

    if (this.settings.showStatusBar) {
      this.statusBar = this.addStatusBarItem();
      this.statusBar.addClass("git-pocket-status");
      this.statusBar.onClickEvent(() => void this.sync(true));
      this.setStatus("Git Pocket");
    }

    const ribbon = this.addRibbonIcon("git-pull-request-arrow", "Git Pocket: sync", () =>
      void this.sync(true),
    );
    ribbon.addClass("git-pocket-ribbon");

    this.app.workspace.onLayoutReady(() => {
      void this.onReady();
    });

    if (this.settings.syncOnBlur) {
      this.registerDomEvent(
        window,
        "blur",
        debounce(() => void this.sync(false), 2000, true),
      );
    }
    this.restartAutoSync();
  }

  onunload() {
    if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
  }

  /* ----------------------------- lifecycle ----------------------------- */

  private async onReady() {
    if (!this.configured()) {
      this.setStatus("Git Pocket: set up");
      return;
    }
    if (!(await this.git.hasGitDir())) {
      this.setStatus("Git Pocket: no repo");
      return;
    }
    await this.refreshStatus();
    if (this.settings.pullOnStartup) await this.startupPull();
  }

  private async startupPull() {
    const { remote, branch } = this.settings;
    try {
      this.setStatus("Checking remote…");
      await this.git.fetch(remote, branch);
      const d = await this.git.divergence(remote, branch);
      await this.refreshStatus();
      if (d.behind === 0) return;

      const canFastForward = d.ahead === 0;
      if (this.settings.pullOnStartupSilent && canFastForward) {
        await this.doPull();
        return;
      }

      new ConfirmModal(
        this.app,
        `${remote}/${branch} is ${d.behind} commit(s) ahead`,
        canFastForward
          ? "Pull them now? Your vault has no local commits to reconcile, so this is a clean fast-forward."
          : `You also have ${d.ahead} local commit(s), so this will create a merge commit. Any conflict aborts and leaves the vault untouched.`,
        "Pull now",
        () => void this.doPull(),
      ).open();
    } catch (e) {
      this.fail("Could not reach the remote", e);
    }
  }

  private restartAutoSync() {
    if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = null;
    const minutes = this.settings.autoSyncMinutes;
    if (minutes <= 0) return;
    this.autoSyncTimer = window.setInterval(
      () => void this.sync(false),
      minutes * 60_000,
    );
    this.registerInterval(this.autoSyncTimer);
  }

  /* ----------------------------- commands ----------------------------- */

  private registerCommands() {
    this.addCommand({
      id: "sync",
      name: "Sync (commit, pull, push)",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "S" }],
      callback: () => void this.sync(true),
    });

    this.addCommand({
      id: "commit",
      name: "Commit all changes",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "C" }],
      callback: () => void this.commitOnly(),
    });

    this.addCommand({
      id: "commit-with-message",
      name: "Commit all changes with a message…",
      callback: () => void this.commitOnly(true),
    });

    this.addCommand({
      id: "squash",
      name: "Squash & rename unpushed commits…",
      callback: () => void this.openSquash(),
    });

    this.addCommand({
      id: "push",
      name: "Push",
      callback: () => void this.guard(async () => {
        await this.git.push(this.settings.remote, this.settings.branch, false, (p) => this.setStatus(p));
        new Notice("Pushed.");
        await this.refreshStatus();
      }),
    });

    this.addCommand({
      id: "pull",
      name: "Pull",
      callback: () => void this.doPull(),
    });

    this.addCommand({
      id: "changes",
      name: "Show uncommitted changes",
      callback: () => void this.guard(async () => {
        const files = await this.git.changedFiles();
        if (files.length === 0) {
          new Notice("Nothing has changed.");
          return;
        }
        new ChangesModal(this.app, files, () => void this.commitOnly()).open();
      }),
    });
  }

  /* ------------------------------ actions ------------------------------ */

  private async commitOnly(prompt = false): Promise<boolean> {
    return this.guard(async () => {
      const files = await this.git.changedFiles();
      if (files.length === 0) {
        new Notice("Nothing to commit.");
        return false;
      }
      const suggested = renderTemplate(this.settings.defaultCommitMessage, {
        count: files.length,
        device: this.deviceName(),
        files: files.map((f) => f.path),
      });

      const run = async (message: string) => {
        this.setStatus("Staging…");
        await this.git.stageAll(files, (p) => this.setStatus(p));
        this.setStatus("Committing…");
        await this.git.commit(message);
        new Notice(`Committed ${files.length} file(s).`);
        await this.refreshStatus();
      };

      if (prompt) {
        return await new Promise<boolean>((resolve) => {
          new TextPromptModal(
            this.app,
            "Commit message",
            `${files.length} file(s) staged.`,
            suggested,
            "Commit",
            (message) => {
              void run(message).then(() => resolve(true));
            },
          ).open();
        });
      }
      await run(suggested);
      return true;
    });
  }

  private async doPull() {
    await this.guard(async () => {
      const dirty = await this.git.changedFiles();
      if (dirty.length > 0) {
        // Pull ends in a checkout, and a forced checkout over uncommitted edits
        // is the one way this plugin could lose a note. Commit first, always.
        new Notice(`Committing ${dirty.length} local change(s) before pulling.`);
        await this.commitInline(dirty.length);
      }
      this.setStatus("Pulling…");
      const result = await this.git.pull(this.settings.remote, this.settings.branch, (p) =>
        this.setStatus(p),
      );
      new Notice(
        result === "up-to-date"
          ? "Already up to date."
          : result === "fast-forward"
            ? "Pulled (fast-forward)."
            : "Pulled and merged.",
      );
      await this.refreshStatus();
    });
  }

  private async commitInline(count: number) {
    const files = await this.git.changedFiles();
    await this.git.stageAll(files);
    await this.git.commit(
      renderTemplate(this.settings.defaultCommitMessage, {
        count,
        device: this.deviceName(),
        files: files.map((f) => f.path),
      }),
    );
  }

  private async openSquash() {
    await this.guard(async () => {
      const commits = await this.git.unpushed(this.settings.remote, this.settings.branch);
      if (commits.length === 0) {
        new Notice("Nothing unpushed to tidy up.");
        return;
      }
      this.presentSquash(commits, false);
    });
  }

  private presentSquash(commits: CommitRow[], pushAfterByDefault: boolean) {
    new SquashModal(
      this.app,
      commits,
      this.settings.squashSelectDaysByDefault,
      (result) => {
        void this.guard(async () => {
          if (result.plan.length > 0) {
            this.setStatus("Rewriting…");
            await this.git.rewriteTip(this.settings.branch, result.plan);
            new Notice(`History rewritten: ${commits.length} → ${result.plan.length}.`);
          }
          if (result.push || pushAfterByDefault) await this.pushWithRetry();
          await this.refreshStatus();
        });
      },
    ).open();
  }

  private async pushWithRetry() {
    this.setStatus("Pushing…");
    try {
      await this.git.push(this.settings.remote, this.settings.branch, false, (p) =>
        this.setStatus(p),
      );
      new Notice("Pushed.");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A rewrite moves commits the remote already has, so the remote refuses the
      // update. Force is correct here and nowhere else, so it is always asked for.
      if (/not a simple fast-forward|non-fast-forward|rejected/i.test(message)) {
        new ConfirmModal(
          this.app,
          "The remote refused this push",
          "Your local history no longer matches the remote's — usually because you just squashed commits that had already been pushed. Force-pushing overwrites the remote branch. Only do this if nobody else is working on it.",
          "Force push",
          () => {
            void this.guard(async () => {
              await this.git.push(this.settings.remote, this.settings.branch, true, (p) =>
                this.setStatus(p),
              );
              new Notice("Force-pushed.");
              await this.refreshStatus();
            });
          },
        ).open();
        return;
      }
      throw e;
    }
  }

  /** commit → pull → (squash) → push. The one button that does the right thing. */
  async sync(interactive: boolean) {
    if (!this.configured()) {
      new Notice("Git Pocket: sign in and pick a repository first.");
      return;
    }
    await this.guard(async () => {
      const files = await this.git.changedFiles();
      if (files.length > 0) {
        this.setStatus(`Staging ${files.length}…`);
        await this.git.stageAll(files, (p) => this.setStatus(p));
        await this.git.commit(
          renderTemplate(this.settings.defaultCommitMessage, {
            count: files.length,
            device: this.deviceName(),
            files: files.map((f) => f.path),
          }),
        );
      }

      this.setStatus("Fetching…");
      await this.git.fetch(this.settings.remote, this.settings.branch);
      const d = await this.git.divergence(this.settings.remote, this.settings.branch);

      if (d.behind > 0) {
        this.setStatus("Merging…");
        await this.git.pull(this.settings.remote, this.settings.branch, (p) => this.setStatus(p));
      }

      const unpushed = await this.git.unpushed(this.settings.remote, this.settings.branch);
      if (unpushed.length === 0) {
        new Notice(files.length === 0 ? "Already up to date." : "Synced.");
        await this.refreshStatus();
        return;
      }

      if (interactive && this.settings.squashBeforePush && unpushed.length > 1) {
        this.presentSquash(unpushed, true);
        return;
      }

      await this.pushWithRetry();
      await this.refreshStatus();
    });
  }

  /* ------------------------------ plumbing ------------------------------ */

  configured(): boolean {
    return this.settings.token.length > 0 && this.settings.repo.length > 0;
  }

  deviceName(): string {
    if (this.settings.deviceName) return this.settings.deviceName;
    if (Platform.isIosApp) return "iphone";
    if (Platform.isAndroidApp) return "android";
    return "desktop";
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T | false> {
    if (this.busy) {
      new Notice("Git Pocket is already working.");
      return false;
    }
    this.busy = true;
    try {
      return await fn();
    } catch (e) {
      this.fail("Git Pocket", e);
      return false;
    } finally {
      this.busy = false;
    }
  }

  private fail(context: string, e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[git-pocket] ${context}`, e);
    new Notice(`${context}: ${message}`, 8000);
    this.setStatus("Git Pocket: error");
  }

  setStatus(text: string) {
    if (this.statusBar) this.statusBar.setText(text);
  }

  async refreshStatus() {
    if (!this.statusBar || !this.configured()) return;
    try {
      const files = await this.git.changedFiles();
      const d = await this.git.divergence(this.settings.remote, this.settings.branch);
      const bits: string[] = [];
      if (files.length) bits.push(`${files.length}●`);
      if (d.ahead) bits.push(`${d.ahead}↑`);
      if (d.behind) bits.push(`${d.behind}↓`);
      this.setStatus(bits.length ? `git ${bits.join(" ")}` : "git ✓");
      this.settings.lastSyncedAt = Date.now();
    } catch {
      this.setStatus("git ?");
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.restartAutoSync();
  }
}
