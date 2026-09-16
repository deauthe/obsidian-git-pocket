import type { DataAdapter } from "obsidian";

function err(code: string, syscall: string, path: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: ${syscall} '${path}'`) as NodeJS.ErrnoException;
  e.code = code;
  e.syscall = syscall;
  e.path = path;
  return e;
}

function rel(path: string): string {
  let p = path.replace(/\\/g, "/");
  while (p.startsWith("/")) p = p.slice(1);
  if (p === "" || p === ".") return "/";
  return p.replace(/\/+$/, "");
}

class Stats {
  type: "file" | "dir";
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
  uid = 0;
  gid = 0;
  dev = 1;
  ino = 0;

  constructor(type: "file" | "dir", size: number, mtimeMs: number, ctimeMs: number) {
    this.type = type;
    this.size = size;
    this.mtimeMs = mtimeMs;
    this.ctimeMs = ctimeMs;
    this.mode = type === "dir" ? 0o40000 : 0o100644;
  }
  get mtime() { return new Date(this.mtimeMs); }
  get ctime() { return new Date(this.ctimeMs); }
  isFile() { return this.type === "file"; }
  isDirectory() { return this.type === "dir"; }
  isSymbolicLink() { return false; }
}

type ReadOpts = string | { encoding?: string } | undefined | null;
function wantsText(opts: ReadOpts): boolean {
  if (!opts) return false;
  if (typeof opts === "string") return opts.startsWith("utf");
  return typeof opts.encoding === "string" && opts.encoding.startsWith("utf");
}

/**
 * isomorphic-git talks to this instead of node:fs. Every call lands on Obsidian's
 * DataAdapter, which is the one filesystem API that exists identically on desktop
 * (node) and on iOS/Android (Capacitor) — which is the whole reason this plugin
 * can offer real git on a phone rather than a REST-API imitation of it.
 *
 * The adapter also reaches dot-directories, so `.git` is readable even though the
 * vault index refuses to show it.
 */
export class ObsidianFs {
  promises: ObsidianFs;
  private a: DataAdapter;

  constructor(adapter: DataAdapter) {
    this.a = adapter;
    this.promises = this;
  }

  async readFile(path: string, opts?: ReadOpts): Promise<string | Uint8Array> {
    const p = rel(path);
    try {
      if (wantsText(opts)) return await this.a.read(p);
      return new Uint8Array(await this.a.readBinary(p));
    } catch {
      throw err("ENOENT", "read", path);
    }
  }

  async writeFile(path: string, data: string | Uint8Array, opts?: ReadOpts): Promise<void> {
    const p = rel(path);
    await this.mkdirp(p.split("/").slice(0, -1).join("/"));
    if (typeof data === "string") await this.a.write(p, data);
    else await this.a.writeBinary(p, toArrayBuffer(data));
  }

  async unlink(path: string): Promise<void> {
    const p = rel(path);
    try {
      await this.a.remove(p);
    } catch {
      /* already gone — unlink is idempotent enough for git's purposes */
    }
  }

  async readdir(path: string): Promise<string[]> {
    const p = rel(path);
    let listing;
    try {
      listing = await this.a.list(p);
    } catch {
      throw err("ENOENT", "scandir", path);
    }
    const names = [...listing.files, ...listing.folders].map((f) => {
      const parts = f.split("/");
      return parts[parts.length - 1];
    });
    return names.filter((n) => n.length > 0);
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const p = rel(path);
    if (opts?.recursive) return this.mkdirp(p);
    if (await this.a.exists(p)) throw err("EEXIST", "mkdir", path);
    await this.a.mkdir(p);
  }

  private async mkdirp(p: string): Promise<void> {
    if (!p || p === "/" || p === ".") return;
    if (await this.a.exists(p)) return;
    const parts = p.split("/");
    let acc = "";
    for (const part of parts) {
      if (!part) continue;
      acc = acc ? `${acc}/${part}` : part;
      if (!(await this.a.exists(acc))) {
        try {
          await this.a.mkdir(acc);
        } catch {
          /* raced with another writer */
        }
      }
    }
  }

  async rmdir(path: string): Promise<void> {
    try {
      await this.a.rmdir(rel(path), true);
    } catch {
      /* non-empty or missing; git treats both as fine */
    }
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const p = rel(path);
    const s = await this.a.stat(p).catch(() => null);
    if (!s) return;
    if (s.type === "folder") await this.a.rmdir(p, true);
    else await this.a.remove(p);
  }

  async stat(path: string): Promise<Stats> {
    const p = rel(path);
    if (p === "/") return new Stats("dir", 0, 0, 0);
    const s = await this.a.stat(p).catch(() => null);
    if (!s) throw err("ENOENT", "stat", path);
    return new Stats(s.type === "folder" ? "dir" : "file", s.size ?? 0, s.mtime ?? 0, s.ctime ?? 0);
  }

  // No symlink support anywhere in the vault API, so lstat is stat and readlink
  // can only ever be reached through a mode git never sees us report.
  async lstat(path: string): Promise<Stats> {
    return this.stat(path);
  }

  async readlink(path: string): Promise<string> {
    throw err("EINVAL", "readlink", path);
  }

  async symlink(_target: string, path: string): Promise<void> {
    throw err("EPERM", "symlink", path);
  }
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}
