// Obsidian on iOS/Android has no Node runtime: no `process`, no `Buffer`.
// isomorphic-git's SHA-1 path reaches both (sha.js -> safe-buffer), and
// async-lock reads `process.domain`, so the bundle carries its own.
// esbuild's `inject` rewrites those free identifiers to these exports.
import { Buffer } from "buffer";

const nodeProcess = (globalThis as { process?: unknown }).process as
  | Record<string, unknown>
  | undefined;

const processShim = nodeProcess ?? {
  env: {},
  platform: "browser",
  browser: true,
  version: "",
  argv: [] as string[],
  domain: null,
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
    Promise.resolve().then(() => fn(...args));
  },
};

export { Buffer, processShim as process };
