import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import { nodeAdapter } from "./adapter.mjs";
import { GitService } from "../build-test/git.js";
import { planFrom, groupByDay, foldedOids } from "../build-test/ui/squash-modal.js";

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};

const commit = (oid, message, timestamp) => ({
  oid, message, tree: "t" + oid, parents: [], timestamp, timezoneOffset: 0,
  author: { name: "a", email: "a@b" },
});

console.log("\nplanFrom");
{
  // newest-first, as the modal receives them
  const cs = [commit("e", "five", 500), commit("d", "four", 400), commit("c", "three", 300),
              commit("b", "two", 200), commit("a", "one", 100)];

  await test("no selection keeps every commit, oldest first", async () => {
    const plan = planFrom(cs, new Set(), new Map());
    assert.equal(plan.length, 5);
    assert.deepEqual(plan.map(g => g.oids[0]), ["a", "b", "c", "d", "e"]);
  });

  await test("a contiguous run collapses into one group", async () => {
    const plan = planFrom(cs, new Set(["c", "d", "e"]), new Map());
    assert.equal(plan.length, 3);
    assert.deepEqual(plan[2].oids, ["e", "d", "c"]);
  });

  await test("a gap in the selection produces two groups, never one", async () => {
    const plan = planFrom(cs, new Set(["e", "d", "b", "a"]), new Map());
    assert.equal(plan.length, 3);
    assert.deepEqual(plan.map(g => g.oids), [["b", "a"], ["c"], ["e", "d"]]);
  });

  await test("the newest commit of a run owns the message", async () => {
    const plan = planFrom(cs, new Set(["d", "e"]), new Map([["e", "renamed"], ["d", "ignored"]]));
    assert.equal(plan[plan.length - 1].message, "renamed");
  });

  await test("folded oids are every non-newest member of a run", async () => {
    assert.deepEqual([...foldedOids(cs, new Set(["e", "d", "c"]))], ["d", "c"]);
  });

  await test("days group by local calendar day", async () => {
    const day1 = Math.floor(new Date(2026, 0, 5, 10).getTime() / 1000);
    const day2 = Math.floor(new Date(2026, 0, 6, 10).getTime() / 1000);
    const days = groupByDay([commit("y", "b", day2), commit("x", "a", day1)]);
    assert.equal(days.length, 2);
  });
}

console.log("\nrewriteTip against a real repository");
{
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gitpocket-"));
  const adapter = nodeAdapter(root);
  const svc = new GitService(adapter, () => ({ token: "", login: "t" }), () => ({ name: "T", email: "t@e" }));
  const raw = { fs: (await import("node:fs")).default, dir: root };

  await svc.init("main");
  const made = [];
  for (const [i, name] of ["one", "two", "three", "four"].entries()) {
    await fsp.writeFile(path.join(root, `${name}.md`), `# ${name}\n`);
    await git.add({ ...raw, filepath: `${name}.md` });
    made.push(await git.commit({
      ...raw, message: name,
      author: { name: "T", email: "t@e", timestamp: 1_760_000_000 + i * 60, timezoneOffset: 0 },
    }));
  }

  const before = (await git.log({ ...raw, ref: "main", depth: 10 }))[0].commit.tree;

  await test("reads back the four commits it just made", async () => {
    const log = await svc.log("main", 10);
    assert.deepEqual(log.map(c => c.message), ["four", "three", "two", "one"]);
  });

  await test("statusMatrix through ObsidianFs sees a new file", async () => {
    await fsp.writeFile(path.join(root, "five.md"), "# five\n");
    const changed = await svc.changedFiles();
    assert.ok(changed.some(f => f.path === "five.md" && f.state === "added"), JSON.stringify(changed));
    await fsp.rm(path.join(root, "five.md"));
  });

  await test("squashing the top three keeps the tip tree byte-identical", async () => {
    const log = await svc.log("main", 10);
    const plan = planFrom(log.slice(0, 3), new Set(log.slice(0, 3).map(c => c.oid)), new Map());
    const head = await svc.rewriteTip("main", plan);
    const after = await git.log({ ...raw, ref: "main", depth: 10 });
    assert.equal(after.length, 2, `expected 2 commits, got ${after.length}`);
    assert.equal(after[0].commit.tree, before, "tip tree changed — content was lost");
    assert.equal(after[0].oid, head);
  });

  await test("every file still exists in the working tree", async () => {
    for (const name of ["one", "two", "three", "four"]) {
      await fsp.access(path.join(root, `${name}.md`));
    }
  });

  await test("dropping a middle commit replays later snapshots intact", async () => {
    const root2 = await fsp.mkdtemp(path.join(os.tmpdir(), "gitpocket2-"));
    const svc2 = new GitService(nodeAdapter(root2), () => ({ token: "", login: "t" }), () => ({ name: "T", email: "t@e" }));
    const raw2 = { fs: (await import("node:fs")).default, dir: root2 };
    await svc2.init("main");
    for (const [i, name] of ["a", "b", "c", "d"].entries()) {
      await fsp.writeFile(path.join(root2, `${name}.md`), `${name}\n`);
      await git.add({ ...raw2, filepath: `${name}.md` });
      await git.commit({ ...raw2, message: name,
        author: { name: "T", email: "t@e", timestamp: 1_760_000_000 + i * 60, timezoneOffset: 0 } });
    }
    const tipTree = (await git.log({ ...raw2, ref: "main", depth: 1 }))[0].commit.tree;
    const log = await svc2.log("main", 10); // d c b a
    // squash b+a (the two oldest), leave c and d alone
    const plan = planFrom(log, new Set([log[2].oid, log[3].oid]), new Map([[log[2].oid, "a+b"]]));
    assert.equal(plan.length, 3);
    await svc2.rewriteTip("main", plan);
    const after = await git.log({ ...raw2, ref: "main", depth: 10 });
    assert.equal(after.length, 3);
    assert.equal(after[0].commit.tree, tipTree, "later snapshot changed");
    assert.deepEqual(after.map(c => c.commit.message.trim()), ["d", "c", "a+b"]);
    await fsp.rm(root2, { recursive: true, force: true });
  });

  await fsp.rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
