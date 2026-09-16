import fs from "node:fs/promises";
import path from "node:path";

const vault = process.argv[2] ?? process.env.OBSIDIAN_VAULT;
if (!vault) {
  console.error("Usage: npm run install-local -- /path/to/vault");
  process.exit(1);
}
const dest = path.join(vault, ".obsidian", "plugins", "git-pocket");
await fs.mkdir(dest, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  await fs.copyFile(f, path.join(dest, f));
}
console.log(`Installed to ${dest}\nEnable "Git Pocket" under Settings → Community plugins.`);
