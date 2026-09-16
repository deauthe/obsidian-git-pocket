export interface GitPocketSettings {
  /** GitHub token. Fine-grained PAT or an OAuth device-flow token. */
  token: string;
  tokenKind: "pat" | "oauth" | "";
  githubLogin: string;

  /** "owner/name" of the repo this vault pushes to. */
  repo: string;
  branch: string;
  remote: string;

  authorName: string;
  authorEmail: string;

  defaultCommitMessage: string;

  /** Ask to pull when the remote is ahead, at startup. */
  pullOnStartup: boolean;
  /** Skip the prompt and just pull when it fast-forwards cleanly. */
  pullOnStartupSilent: boolean;

  /** Offer the squash sheet before every push. */
  squashBeforePush: boolean;
  /** Pre-select each day group in the squash sheet. */
  squashSelectDaysByDefault: boolean;

  /** Commit + push on a timer, for phones where you never remember to sync. */
  autoSyncMinutes: number;
  /** Sync when the app goes to the background / the window loses focus. */
  syncOnBlur: boolean;

  lineWidthWarning: boolean;
  showStatusBar: boolean;
  /** Device label, used by {{device}} in the message template. */
  deviceName: string;

  /** Advanced: your own OAuth app, for device-flow login. */
  oauthClientId: string;

  lastSyncedAt: number;
}

export const DEFAULT_SETTINGS: GitPocketSettings = {
  token: "",
  tokenKind: "",
  githubLogin: "",
  repo: "",
  branch: "main",
  remote: "origin",
  authorName: "",
  authorEmail: "",
  defaultCommitMessage: "vault: {{date}} {{time}} ({{device}}) — {{count}} file(s)",
  pullOnStartup: true,
  pullOnStartupSilent: false,
  squashBeforePush: true,
  squashSelectDaysByDefault: true,
  autoSyncMinutes: 0,
  syncOnBlur: false,
  lineWidthWarning: true,
  showStatusBar: true,
  deviceName: "",
  oauthClientId: "",
  lastSyncedAt: 0,
};

export function renderTemplate(
  tpl: string,
  vars: { count: number; device: string; files: string[] },
): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const first = vars.files[0] ?? "";
  const basename = first.split("/").pop()?.replace(/\.md$/, "") ?? "";

  return tpl
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{time\}\}/g, time)
    .replace(/\{\{count\}\}/g, String(vars.count))
    .replace(/\{\{device\}\}/g, vars.device || "obsidian")
    .replace(/\{\{files\}\}/g, vars.files.slice(0, 3).join(", "))
    .replace(/\{\{file\}\}/g, basename)
    .trim();
}
