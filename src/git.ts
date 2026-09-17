import git from "isomorphic-git";
import type { DataAdapter } from "obsidian";
import { ObsidianFs } from "./fs";
import { http } from "./http";

export interface Author {
  name: string;
  email: string;
}

export interface CommitRow {
  oid: string;
  message: string;
  tree: string;
  parents: string[];
  timestamp: number;
  timezoneOffset: number;
  author: { name: string; email: string };
}

export interface Divergence {
  ahead: number;
  behind: number;
  base: string | null;
  localOid: string | null;
  remoteOid: string | null;
}

export interface ChangedFile {
  path: string;
  state: "added" | "modified" | "deleted";
}

/** One entry of a history rewrite: the commits it replaces, and its new message. */
export interface RewriteGroup {
  oids: string[];
  message: string;
}

export type Progress = (phase: string) => void;

export class GitService {
  private fs: ObsidianFs;
  private dir = "/";
  private cache: Record<string, unknown> = {};

  constructor(
    adapter: DataAdapter,
    private auth: () => { token: string; login: string },
    private author: () => Author,
  ) {
    this.fs = new ObsidianFs(adapter);
  }

  private base() {
    return { fs: this.fs, dir: this.dir, cache: this.cache };
  }

  private onAuth = () => {
    const { token, login } = this.auth();
    // GitHub accepts the token as the password with any non-empty username.
    return { username: login || "x-access-token", password: token };
  };

  /** Drop the object cache. Anything that moves a ref has to call this. */
  invalidate() {
    this.cache = {};
  }

  async hasGitDir(): Promise<boolean> {
    try {
      await this.fs.stat("/.git");
      return true;
    } catch {
      return false;
    }
  }

  async init(branch: string): Promise<void> {
    await git.init({ fs: this.fs, dir: this.dir, defaultBranch: branch });
    this.invalidate();
  }

  async setRemote(remote: string, url: string): Promise<void> {
    await git.addRemote({ ...this.base(), remote, url, force: true });
  }

  /* ------------------------------ status ------------------------------ */

  async changedFiles(): Promise<ChangedFile[]> {
    const matrix = await git.statusMatrix(this.base());
    const out: ChangedFile[] = [];
    for (const [path, head, workdir, stage] of matrix) {
      if (head === 1 && workdir === 1 && stage === 1) continue;
      if (head === 0 && workdir === 0) continue;
      if (head === 0) {
        // statusMatrix walks the working tree without consulting .gitignore, so an
        // untracked path has to be checked before it is offered as a change.
        if (await git.isIgnored({ ...this.base(), filepath: path })) continue;
        out.push({ path, state: "added" });
      } else if (workdir === 0) {
        out.push({ path, state: "deleted" });
      } else {
        out.push({ path, state: "modified" });
      }
    }
    return out;
  }

  async stageAll(files: ChangedFile[], onProgress?: Progress): Promise<void> {
    let n = 0;
    for (const f of files) {
      if (f.state === "deleted") await git.remove({ ...this.base(), filepath: f.path });
      else await git.add({ ...this.base(), filepath: f.path });
      n++;
      if (onProgress && n % 25 === 0) onProgress(`Staging ${n}/${files.length}`);
    }
  }

  async commit(message: string): Promise<string> {
    const a = this.author();
    const oid = await git.commit({
      ...this.base(),
      message,
      author: { name: a.name, email: a.email },
    });
    this.invalidate();
    return oid;
  }

  /* ------------------------------ remote ------------------------------ */

  async fetch(remote: string, branch: string, onProgress?: Progress): Promise<void> {
    await git.fetch({
      ...this.base(),
      http,
      remote,
      ref: branch,
      singleBranch: true,
      tags: false,
      prune: false,
      onAuth: this.onAuth,
      onProgress: onProgress ? (p) => onProgress(`${p.phase} ${p.loaded}`) : undefined,
    });
    this.invalidate();
  }

  async divergence(remote: string, branch: string): Promise<Divergence> {
    const localOid = await this.tryResolve(`refs/heads/${branch}`);
    const remoteOid = await this.tryResolve(`refs/remotes/${remote}/${branch}`);
    if (!localOid || !remoteOid) {
      return { ahead: 0, behind: 0, base: null, localOid, remoteOid };
    }
    if (localOid === remoteOid) {
      return { ahead: 0, behind: 0, base: localOid, localOid, remoteOid };
    }
    const base = await this.mergeBase(localOid, remoteOid);
    const ahead = base ? await this.countTo(localOid, base) : 0;
    const behind = base ? await this.countTo(remoteOid, base) : 0;
    return { ahead, behind, base, localOid, remoteOid };
  }

  /**
   * isomorphic-git declares findMergeBase as `Promise<any[]>`, so this is the
   * single place that untyped boundary is crossed. Both callers want the same
   * thing — one oid or nothing — and both treat a failure as "no common base".
   */
  private async mergeBase(a: string, b: string): Promise<string | null> {
    try {
      const bases = (await git.findMergeBase({ ...this.base(), oids: [a, b] })) as string[];
      return bases[0] ?? null;
    } catch {
      return null;
    }
  }

  private async tryResolve(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ ...this.base(), ref });
    } catch {
      return null;
    }
  }

  private async countTo(from: string, stop: string): Promise<number> {
    const log = await git.log({ ...this.base(), ref: from, depth: 500 });
    let n = 0;
    for (const entry of log) {
      if (entry.oid === stop) break;
      n++;
    }
    return n;
  }

  /**
   * Fast-forward if we can, merge if we must, and refuse rather than leave a
   * conflicted working tree — a phone is the worst possible place to resolve one.
   */
  async pull(
    remote: string,
    branch: string,
    onProgress?: Progress,
  ): Promise<"up-to-date" | "fast-forward" | "merged"> {
    await this.fetch(remote, branch, onProgress);
    const d = await this.divergence(remote, branch);
    if (!d.remoteOid) throw new Error(`No remote branch ${remote}/${branch}.`);
    if (d.behind === 0) return "up-to-date";

    const a = this.author();
    const fastForward = d.ahead === 0;
    await git.merge({
      ...this.base(),
      ours: branch,
      theirs: `refs/remotes/${remote}/${branch}`,
      fastForwardOnly: fastForward,
      abortOnConflict: true,
      author: { name: a.name, email: a.email },
      message: `merge ${remote}/${branch}`,
    });
    this.invalidate();
    // merge moves the ref; the working tree only follows on an explicit checkout.
    await git.checkout({ ...this.base(), ref: branch, force: true });
    this.invalidate();
    return fastForward ? "fast-forward" : "merged";
  }

  async push(remote: string, branch: string, force = false, onProgress?: Progress): Promise<void> {
    const result = await git.push({
      ...this.base(),
      http,
      remote,
      ref: branch,
      remoteRef: branch,
      force,
      onAuth: this.onAuth,
      onProgress: onProgress ? (p) => onProgress(`${p.phase} ${p.loaded}`) : undefined,
    });
    if (result.error) throw new Error(result.error);
    const rejected = (result.refs ?? {})[`refs/heads/${branch}`];
    if (rejected && rejected.ok === false) {
      throw new Error(rejected.error ?? "Push rejected.");
    }
    this.invalidate();
  }

  /* ------------------------------ history ------------------------------ */

  async log(ref: string, depth: number): Promise<CommitRow[]> {
    const entries = await git.log({ ...this.base(), ref, depth });
    return entries.map((e) => ({
      oid: e.oid,
      message: e.commit.message.trim(),
      tree: e.commit.tree,
      parents: e.commit.parent,
      timestamp: e.commit.author.timestamp,
      timezoneOffset: e.commit.author.timezoneOffset,
      author: { name: e.commit.author.name, email: e.commit.author.email },
    }));
  }

  /** Commits on `branch` that the remote has not seen yet, newest first. */
  async unpushed(remote: string, branch: string): Promise<CommitRow[]> {
    const localOid = await this.tryResolve(`refs/heads/${branch}`);
    if (!localOid) return [];
    const remoteOid = await this.tryResolve(`refs/remotes/${remote}/${branch}`);

    let stop: string | null = remoteOid;
    if (remoteOid && remoteOid !== localOid) {
      stop = (await this.mergeBase(localOid, remoteOid)) ?? remoteOid;
    }

    const log = await this.log(branch, 300);
    const out: CommitRow[] = [];
    for (const c of log) {
      if (stop && c.oid === stop) break;
      out.push(c);
    }
    return out;
  }

  /**
   * Replace the unpushed tip of `branch` with `groups` (oldest group first).
   *
   * Each group becomes ONE commit whose tree is the tree of the NEWEST commit in
   * it — which is exactly what `reset --soft` + `commit` produces, and is why a
   * group may only ever be a contiguous run. Commits outside any group are
   * replayed with their own tree onto the new parent chain, so dropping an older
   * commit from the middle still leaves every later snapshot byte-identical.
   *
   * Merge commits are refused: re-parenting one silently discards a side of the
   * history, and there is no safe automatic answer.
   */
  async rewriteTip(branch: string, groups: RewriteGroup[]): Promise<string> {
    if (groups.length === 0) throw new Error("Nothing to rewrite.");

    const byOid = new Map<string, CommitRow>();
    const all = await this.log(branch, 300);
    for (const c of all) byOid.set(c.oid, c);

    const oldest = groups[0].oids[groups[0].oids.length - 1];
    const oldestCommit = byOid.get(oldest);
    if (!oldestCommit) throw new Error("Lost track of the oldest commit being rewritten.");
    if (oldestCommit.parents.length > 1) throw new Error("Cannot rewrite across a merge commit.");

    for (const g of groups) {
      for (const oid of g.oids) {
        const c = byOid.get(oid);
        if (!c) throw new Error(`Unknown commit ${oid.slice(0, 7)}.`);
        if (c.parents.length > 1) throw new Error("Cannot rewrite a merge commit.");
      }
    }

    let parent = oldestCommit.parents[0] ?? null;
    const a = this.author();
    const now = Math.floor(Date.now() / 1000);
    const tzOffset = new Date().getTimezoneOffset();

    let head = parent ?? "";
    for (const g of groups) {
      const newest = byOid.get(g.oids[0]);
      if (!newest) throw new Error("Lost track of a commit being rewritten.");
      const message = g.message.trim() || newest.message;
      const oid = await git.writeCommit({
        ...this.base(),
        commit: {
          message: message.endsWith("\n") ? message : `${message}\n`,
          tree: newest.tree,
          parent: parent ? [parent] : [],
          // Authorship belongs to whoever wrote the work; the rewrite is a commit.
          author: {
            name: newest.author.name,
            email: newest.author.email,
            timestamp: newest.timestamp,
            timezoneOffset: newest.timezoneOffset,
          },
          committer: { name: a.name, email: a.email, timestamp: now, timezoneOffset: tzOffset },
        },
      });
      parent = oid;
      head = oid;
    }

    await git.writeRef({ ...this.base(), ref: `refs/heads/${branch}`, value: head, force: true });
    this.invalidate();
    // The tip tree is unchanged by construction, so the index and working tree
    // already match; only the index's recorded HEAD needs to catch up.
    await git.checkout({ ...this.base(), ref: branch, force: true });
    this.invalidate();
    return head;
  }

  async readGitignore(): Promise<string | null> {
    try {
      return (await this.fs.readFile("/.gitignore", "utf8")) as string;
    } catch {
      return null;
    }
  }

  async writeGitignore(content: string): Promise<void> {
    await this.fs.writeFile("/.gitignore", content);
  }
}
