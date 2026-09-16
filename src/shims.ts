// Obsidian on iOS/Android has no Node runtime: no `process`, no `Buffer`.
// isomorphic-git's SHA-1 path reaches both (sha.js -> safe-buffer), and
// async-lock reads `process.domain`. esbuild's `inject` rewrites those free
// identifiers to these exports.
//
// The specifier is "buffer/" — with the trailing slash — on purpose. That is
// the npm `buffer` package (pure JS, browser-safe), NOT Node's builtin: the
// builtin does not exist on mobile, which is the very thing this file answers.
// Importing it as "buffer" resolves identically but is indistinguishable from
// a builtin import to a reviewer and to a linter.
import { Buffer } from "buffer/";

// Deliberately static, with no attempt to detect and prefer a host `process`.
// Nothing here needs the real one: `process.env.NODE_ENV` is substituted at
// build time, and the only runtime read is async-lock's `process.domain`, for
// which undefined is the correct answer. Detecting the host would mean reaching
// for an ambient global — one spelling of which the plugin guidelines rule out,
// and the other of which is absent when the test harness runs this under Node.
const processShim = {
  env: {} as Record<string, string | undefined>,
  platform: "browser",
  browser: true,
  version: "",
  argv: [] as string[],
  domain: null,
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
    void Promise.resolve().then(() => fn(...args));
  },
};

export { Buffer, processShim as process };
