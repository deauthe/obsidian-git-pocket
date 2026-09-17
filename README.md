# Git Pocket

Git for Obsidian that is meant to be used on a phone, not merely survivable on one.

Commit, squash, pull and push your vault to GitHub from desktop, iOS or Android.
No shell, no Node, no Working Copy hand-off.

## What it does

- **Run it from settings.** Sync now, Commit all changes, and the squash sheet
  are rows at the top of the settings tab, not just palette commands.
- **Sign in to GitHub** with a fine-grained token (one tap to the token page, paste
  it back), or with OAuth device login if you point it at your own OAuth app.
- **Pick the repository** from a searchable list of everything you can push to.
- **Commit and sync commands** you can bind to any key. No default hotkeys ship,
  so nothing of yours is overridden; the settings tab opens Obsidian's Hotkeys
  pane filtered to this plugin. (Obsidian owns key binding — no plugin can
  offer a binder inside its own settings.)
- **A default commit message** with placeholders — `{{date}} {{time}} {{count}}
  {{files}} {{file}} {{device}}`.
- **Squash before pushing.** Unpushed commits are grouped by day; each day has a
  one-tap *Squash day*, individual commits can be selected, and every message is
  editable in place.
- **Ask to pull on startup** when the remote branch is ahead, with the merge
  consequence spelled out before you agree to it.
- **Auto-sync** on a timer and/or when Obsidian loses focus.

## Why it works on a phone

Obsidian's mobile app has no Node runtime, no shell, and no filesystem outside the
vault. Three decisions follow from that, and they are the whole design:

1. **Git is [isomorphic-git](https://isomorphic-git.org), not a shelled-out `git`.**
   `.git` is a real repository: real objects, real history, readable by desktop git.
   A GitHub-REST-API imitation would have no local history to squash.
2. **The filesystem is Obsidian's own `DataAdapter`** (`src/fs.ts`). It is the one
   API that behaves identically under Electron and under Capacitor, and it reaches
   dot-directories, so `.git` is readable even though the vault index hides it.
3. **HTTP is `requestUrl`, not `fetch`** (`src/http.ts`). GitHub serves no CORS
   headers on its smart-HTTP endpoints, so a plugin `fetch()` to github.com is
   refused. `requestUrl` is a native request with no origin to be refused for.

Other choices made for the phone specifically:

- **Sync is one button that does the whole thing** — commit, fetch, merge, squash,
  push — because a phone is not where you want to run four commands in order.
- **A pull always commits your local edits first.** A pull ends in a checkout, and a
  forced checkout over uncommitted edits is the one way this plugin could lose a
  note.
- **Merge conflicts abort rather than write conflict markers.** Resolving a
  three-way conflict on a phone keyboard is not a thing anyone wants to do, so a
  conflicting pull leaves the vault exactly as it was and says so.
- **Force-push is always a separate, explicit confirmation**, never automatic — it
  is only ever reached after you squash commits the remote already had.
- **A starter `.gitignore`** that excludes `.obsidian/workspace.json` and friends,
  which are per-device files and the single biggest source of phone-vs-desktop
  conflicts.
- Big tap targets, sticky day headers, sticky action bar, and `.is-mobile` styling
  in `styles.css`.

## How squashing works

Only **unpushed** commits are offered, so shared history is never rewritten behind
your back.

Selected commits collapse into the one **above** them (the newer one), and the
modal dims and disables the folded rows so that is visible rather than inferred.
The collapsed commit carries the newest member's **tree** — which is exactly what
`git reset --soft <base> && git commit` produces.

Only a *contiguous* run collapses. A selection with a gap in it produces two
groups, never one: skipping a commit in the middle would need its snapshot
reconstructed, which is a rebase and not a squash. Commits outside any group are
replayed with their own tree onto the new parent chain, so dropping an older commit
still leaves every later snapshot byte-identical — there is a test for exactly that.

Merge commits are refused outright; re-parenting one silently discards a side of
the history.

## Install

```bash
npm install
npm run build
npm run install-local -- /path/to/your/vault
```

Then enable **Git Pocket** under Settings → Community plugins, sign in, pick a
repo, and hit *Check / set up* if the vault is not a git repository yet.

`npm run dev` rebuilds on change; re-run `install-local` (or symlink the folder) to
pick the rebuild up.

## Tests

```bash
npm test
```

Exercises `planFrom` (the selection → plan mapping) and drives the real
`GitService` and `ObsidianFs` against a real repository on disk, asserting that a
squash leaves the tip tree byte-identical and every file present. Both of those go
red if the rewrite picks the wrong end of a run — verified by breaking it.

## Security

Your token lives in this vault's plugin data, unencrypted — the same place every
Obsidian plugin keeps its settings. Use a **fine-grained** token scoped to the one
repository, so a leaked vault costs you that repo and nothing else.

### Clipboard

The plugin writes to the system clipboard in exactly one place: the device-login
code dialog, which copies the GitHub user code you're asked to enter on
github.com. It never reads the clipboard, and the write only happens when you
tap the code or the "Copy code" button. This dialog only appears if you've set
up your own OAuth app client ID under Advanced settings — the default sign-in
flow is pasting a token and never touches the clipboard.

## Known limits

- No conflict resolution UI. Conflicting merges abort.
- No submodules, no LFS, no SSH remotes (HTTPS + token only).
- `statusMatrix` walks the whole vault, so the first status on a very large vault
  is slow; results are cached until a ref moves.
- Squash operates on the unpushed tip only. Rewriting anything older needs desktop
  git.
