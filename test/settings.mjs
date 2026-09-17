import assert from "node:assert/strict";
import { Setting, GitPocketSettingTab, DEFAULT_SETTINGS } from "../build-test/entry.js";

export async function run(test) {
  const fakePlugin = (overrides = {}) => ({
    settings: { ...DEFAULT_SETTINGS, ...(overrides.settings ?? {}) },
    git: { hasGitDir: async () => true, readGitignore: async () => null },
    deviceName: () => "desktop",
    configured: function () { return this.settings.token.length > 0 && this.settings.repo.length > 0; },
    saveSettings: async () => {},
    manifest: { id: "git-pocket" },
  });

  const render = (plugin) => {
    Setting.rendered.length = 0;
    const tab = new GitPocketSettingTab({}, plugin);
    tab.display();
    return { tab, rows: [...Setting.rendered] };
  };

  await test("the pre-1.13 display() fallback renders rows, not a blank tab", async () => {
    const { rows } = render(fakePlugin());
    assert.ok(rows.length > 15, `expected a populated tab, got ${rows.length} rows`);
  });

  await test("the fallback renders every group heading", async () => {
    const { rows } = render(fakePlugin());
    const headings = rows.filter((r) => r.heading).map((r) => r.name);
    assert.deepEqual(headings, ["Actions", "GitHub", "Repository", "Committing", "Syncing", "Advanced"]);
  });

  await test("a signed-out vault is offered a way to sign in", async () => {
    const { rows } = render(fakePlugin());
    const names = rows.map((r) => r.name);
    assert.ok(names.includes("Sign in with a token"), names.join(" | "));
    assert.ok(!names.includes("Signed in"), "signed-out tab must not show the sign-out row");
  });

  await test("a signed-in vault is offered a way to sign out", async () => {
    const { rows } = render(fakePlugin({ settings: { token: "t", githubLogin: "me", repo: "me/v" } }));
    const names = rows.map((r) => r.name);
    assert.ok(names.includes("Signed in"), names.join(" | "));
    assert.ok(!names.includes("Sign in with a token"));
  });

  await test("controls are bound to real setting keys, not dropped", async () => {
    const { rows } = render(fakePlugin());
    const withControls = rows.filter((r) => r.controls.length > 0);
    assert.ok(withControls.length >= 12, `only ${withControls.length} controls rendered`);
    const kinds = new Set(withControls.flatMap((r) => r.controls));
    for (const k of ["toggle", "text", "textarea", "slider"]) {
      assert.ok(kinds.has(k), `no ${k} control rendered`);
    }
  });

  await test("action rows are clickable and disabled ones are not", async () => {
    const off = render(fakePlugin());
    const syncOff = off.rows.find((r) => r.name === "Sync now");
    assert.ok(syncOff, "Sync now row missing");
    assert.ok(syncOff.settingEl.cls.has("is-disabled"), "Sync now must be disabled when unconfigured");
    assert.equal(syncOff.settingEl.handlers.length, 0, "a disabled row must not be clickable");

    const on = render(fakePlugin({ settings: { token: "t", githubLogin: "me", repo: "me/v" } }));
    const syncOn = on.rows.find((r) => r.name === "Sync now");
    assert.ok(!syncOn.settingEl.cls.has("is-disabled"));
    assert.equal(syncOn.settingEl.handlers.length, 1, "an enabled row must be clickable");
  });

  await test("both renderers read one source: every definition name appears", async () => {
    const { tab, rows } = render(fakePlugin());
    const names = new Set(rows.map((r) => r.name));
    const walk = (items, out = []) => {
      for (const it of items) {
        if (it.type === "group" || it.type === "list") { walk(it.items ?? [], out); continue; }
        out.push(it);
      }
      return out;
    };
    const defs = walk(tab.getSettingDefinitions());
    const visible = defs.filter((d) => (typeof d.visible === "function" ? d.visible() : d.visible !== false));
    for (const d of visible) assert.ok(names.has(d.name), `definition "${d.name}" never rendered`);
    assert.ok(visible.length > 15);
  });
}
