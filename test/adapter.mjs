import fs from "node:fs/promises";
import path from "node:path";

/** Node-backed stand-in for Obsidian's DataAdapter, with the same contract. */
export function nodeAdapter(root) {
  const abs = (p) => path.join(root, p === "/" ? "" : p);
  return {
    async read(p) { return fs.readFile(abs(p), "utf8"); },
    async readBinary(p) {
      const b = await fs.readFile(abs(p));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    async write(p, data) { await fs.writeFile(abs(p), data); },
    async writeBinary(p, data) { await fs.writeFile(abs(p), Buffer.from(data)); },
    async exists(p) { try { await fs.stat(abs(p)); return true; } catch { return false; } },
    async list(p) {
      const entries = await fs.readdir(abs(p), { withFileTypes: true });
      const base = p === "/" ? "" : p;
      const files = [], folders = [];
      for (const e of entries) {
        const full = base ? `${base}/${e.name}` : e.name;
        (e.isDirectory() ? folders : files).push(full);
      }
      return { files, folders };
    },
    async mkdir(p) { await fs.mkdir(abs(p), { recursive: true }); },
    async rmdir(p, recursive) { await fs.rm(abs(p), { recursive: !!recursive, force: true }); },
    async remove(p) { await fs.rm(abs(p), { force: true }); },
    async stat(p) {
      try {
        const s = await fs.stat(abs(p));
        return { type: s.isDirectory() ? "folder" : "file", ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
      } catch { return null; }
    },
  };
}
