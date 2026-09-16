import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // `buffer` is deliberately NOT external: it is the one builtin the git
  // implementation actually reaches, and leaving it as a bare require() makes
  // the plugin desktop-only. Everything else stays external.
  external: ["obsidian", "electron", ...builtinModules.filter((m) => m !== "buffer")],
  inject: ["src/shims.ts"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  define: { "process.env.NODE_ENV": prod ? '"production"' : '"development"' },
  outfile: "main.js",
});

if (prod) { await ctx.rebuild(); process.exit(0); } else { await ctx.watch(); }
