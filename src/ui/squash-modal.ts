import { App, Modal, Notice } from "obsidian";
import type { CommitRow, RewriteGroup } from "../git";

interface DayGroup {
  key: string;
  label: string;
  commits: CommitRow[];
}

function dayKey(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(new Date()) - startOf(date)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function groupByDay(commits: CommitRow[]): DayGroup[] {
  const map = new Map<string, CommitRow[]>();
  for (const c of commits) {
    const k = dayKey(c.timestamp);
    const list = map.get(k) ?? [];
    list.push(c);
    map.set(k, list);
  }
  return [...map.entries()].map(([key, list]) => ({ key, label: dayLabel(key), commits: list }));
}

/**
 * Turn a selection into a rewrite plan.
 *
 * `commits` arrives newest-first; the plan is emitted oldest-first because that
 * is the order the new parent chain has to be written in. Only a CONTIGUOUS run
 * of selected commits collapses — a selection with a gap in it would need the
 * skipped commit's snapshot reconstructed, which is a rebase, not a squash.
 *
 * The NEWEST commit of a run owns the group's message, because its tree is the
 * one the collapsed commit carries. The modal marks the others as folded so that
 * is visible rather than inferred.
 */
export function planFrom(
  commits: CommitRow[],
  selected: Set<string>,
  messages: Map<string, string>,
): RewriteGroup[] {
  const groups: RewriteGroup[] = [];
  let run: CommitRow[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const owner = run[0];
    groups.push({
      oids: run.map((c) => c.oid),
      message: messages.get(owner.oid) ?? owner.message,
    });
    run = [];
  };

  for (const c of commits) {
    if (selected.has(c.oid)) {
      run.push(c);
    } else {
      flush();
      groups.push({ oids: [c.oid], message: messages.get(c.oid) ?? c.message });
    }
  }
  flush();
  return groups.reverse();
}

/** The oids whose message input is disabled: every non-newest member of a run. */
export function foldedOids(commits: CommitRow[], selected: Set<string>): Set<string> {
  const folded = new Set<string>();
  let inRun = false;
  for (const c of commits) {
    if (selected.has(c.oid)) {
      if (inRun) folded.add(c.oid);
      inRun = true;
    } else {
      inRun = false;
    }
  }
  return folded;
}

export interface SquashResult {
  plan: RewriteGroup[];
  push: boolean;
}

export class SquashModal extends Modal {
  private selected = new Set<string>();
  private messages = new Map<string, string>();
  private days: DayGroup[];
  private listEl!: HTMLElement;
  private summaryEl!: HTMLElement;

  constructor(
    app: App,
    private commits: CommitRow[],
    preselectDays: boolean,
    private onSubmit: (result: SquashResult) => void,
  ) {
    super(app);
    this.days = groupByDay(commits);
    if (preselectDays) {
      for (const day of this.days) {
        if (day.commits.length > 1) for (const c of day.commits) this.selected.add(c.oid);
      }
    }
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("git-pocket-modal");
    contentEl.addClass("git-pocket-squash");

    contentEl.createEl("h2", { text: "Tidy up before pushing" });
    contentEl.createEl("p", {
      cls: "git-pocket-sub",
      text: `${this.commits.length} commit(s) the remote has not seen. Selected commits collapse into the one above them; every message is editable.`,
    });

    this.listEl = contentEl.createDiv({ cls: "git-pocket-days" });
    this.summaryEl = contentEl.createDiv({ cls: "git-pocket-summary" });

    const actions = contentEl.createDiv({ cls: "git-pocket-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const applyOnly = actions.createEl("button", { text: "Apply only" });
    applyOnly.onclick = () => this.submit(false);
    const applyPush = actions.createEl("button", { text: "Apply & push", cls: "mod-cta" });
    applyPush.onclick = () => this.submit(true);

    this.render();
  }

  private render() {
    this.listEl.empty();
    const folded = foldedOids(this.commits, this.selected);
    for (const day of this.days) this.renderDay(this.listEl, day, folded);
    this.renderSummary();
  }

  private renderDay(parent: HTMLElement, day: DayGroup, folded: Set<string>) {
    const section = parent.createDiv({ cls: "git-pocket-day" });
    const header = section.createDiv({ cls: "git-pocket-day-header" });

    const title = header.createDiv({ cls: "git-pocket-day-title" });
    title.createSpan({ text: day.label, cls: "git-pocket-day-label" });
    title.createSpan({ text: `${day.commits.length} commit(s)`, cls: "git-pocket-day-count" });

    const all = day.commits.every((c) => this.selected.has(c.oid));
    const toggle = header.createEl("button", {
      cls: "git-pocket-day-toggle",
      text: all ? "Clear day" : "Squash day",
    });
    toggle.onclick = () => {
      for (const c of day.commits) {
        if (all) this.selected.delete(c.oid);
        else this.selected.add(c.oid);
      }
      this.render();
    };

    for (const c of day.commits) this.renderCommit(section, c, folded.has(c.oid));
  }

  private renderCommit(parent: HTMLElement, c: CommitRow, isFolded: boolean) {
    const row = parent.createDiv({ cls: "git-pocket-commit" });
    if (isFolded) row.addClass("is-folded");

    const box = row.createEl("input", { type: "checkbox", cls: "git-pocket-check" });
    box.checked = this.selected.has(c.oid);
    box.onchange = () => {
      if (box.checked) this.selected.add(c.oid);
      else this.selected.delete(c.oid);
      this.render();
    };

    const body = row.createDiv({ cls: "git-pocket-commit-body" });
    const input = body.createEl("input", {
      type: "text",
      cls: "git-pocket-message",
      value: this.messages.get(c.oid) ?? c.message.split("\n")[0],
    });
    input.disabled = isFolded;
    input.oninput = () => this.messages.set(c.oid, input.value);

    const time = new Date(c.timestamp * 1000).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    body.createDiv({
      cls: "git-pocket-meta",
      text: isFolded
        ? `${c.oid.slice(0, 7)} · ${time} · folded into the commit above`
        : `${c.oid.slice(0, 7)} · ${time} · ${c.author.name}`,
    });
  }

  private renderSummary() {
    const plan = planFrom(this.commits, this.selected, this.messages);
    this.summaryEl.setText(
      plan.length === this.commits.length
        ? `${this.commits.length} commit(s) kept. Messages still editable.`
        : `${this.commits.length} commit(s) → ${plan.length}.`,
    );
  }

  private submit(push: boolean) {
    const plan = planFrom(this.commits, this.selected, this.messages);
    const unchanged =
      plan.length === this.commits.length &&
      plan.every((g, i) => {
        const original = this.commits[this.commits.length - 1 - i];
        return g.message.trim() === original.message.trim();
      });

    this.close();
    if (unchanged && !push) {
      new Notice("Nothing to change.");
      return;
    }
    this.onSubmit({ plan: unchanged ? [] : plan, push });
  }

  onClose() {
    this.contentEl.empty();
  }
}
