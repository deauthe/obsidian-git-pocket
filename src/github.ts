import { requestUrl } from "obsidian";

export interface RepoSummary {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
}

const API = "https://api.github.com";

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "obsidian-git-pocket",
  };
}

export async function verifyToken(token: string): Promise<{ login: string; email: string }> {
  const res = await requestUrl({ url: `${API}/user`, headers: headers(token), throw: false });
  if (res.status === 401) throw new Error("GitHub rejected that token (401).");
  if (res.status >= 400) throw new Error(`GitHub returned ${res.status} for /user.`);
  const user = res.json as { login: string; email: string | null; id: number };
  // A GitHub account with a private email still has a routable noreply address,
  // and using it means a commit from the phone is still attributed on github.com.
  const email = user.email ?? `${user.id}+${user.login}@users.noreply.github.com`;
  return { login: user.login, email };
}

export async function listRepos(token: string): Promise<RepoSummary[]> {
  const out: RepoSummary[] = [];
  for (let page = 1; page <= 4; page++) {
    const res = await requestUrl({
      url: `${API}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`,
      headers: headers(token),
      throw: false,
    });
    if (res.status >= 400) throw new Error(`GitHub returned ${res.status} listing repositories.`);
    const batch = res.json as Array<{
      full_name: string;
      default_branch: string;
      private: boolean;
      updated_at: string;
      permissions?: { push?: boolean };
    }>;
    for (const r of batch) {
      if (r.permissions && r.permissions.push === false) continue;
      out.push({
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        private: r.private,
        updatedAt: r.updated_at,
      });
    }
    if (batch.length < 100) break;
  }
  return out;
}

/** The URL that pre-fills a fine-grained PAT with exactly the scope this plugin needs. */
export function newTokenUrl(): string {
  return "https://github.com/settings/personal-access-tokens/new";
}

/* ---------- OAuth device flow (optional, needs your own OAuth app) ---------- */

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function startDeviceFlow(clientId: string): Promise<DeviceCode> {
  const res = await requestUrl({
    url: "https://github.com/login/device/code",
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "repo" }),
    throw: false,
  });
  if (res.status >= 400) throw new Error(`GitHub returned ${res.status} starting device login.`);
  const json = res.json as DeviceCode & { error_description?: string };
  if (!json.device_code) throw new Error(json.error_description ?? "No device code returned.");
  return json;
}

export async function pollDeviceFlow(
  clientId: string,
  code: DeviceCode,
  signal: { cancelled: boolean },
): Promise<string> {
  const deadline = Date.now() + code.expires_in * 1000;
  let interval = Math.max(code.interval, 5) * 1000;

  while (Date.now() < deadline) {
    if (signal.cancelled) throw new Error("Sign-in cancelled.");
    await sleep(interval);
    const res = await requestUrl({
      url: "https://github.com/login/oauth/access_token",
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      throw: false,
    });
    const json = res.json as { access_token?: string; error?: string; interval?: number };
    if (json.access_token) return json.access_token;
    if (json.error === "authorization_pending") continue;
    if (json.error === "slow_down") {
      interval = Math.max(interval + 5000, (json.interval ?? 10) * 1000);
      continue;
    }
    throw new Error(json.error ?? "Device login failed.");
  }
  throw new Error("Device login timed out.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}
