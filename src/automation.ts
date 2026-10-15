import { TFile, TFolder, type App, type FrontMatterCache } from "obsidian";
import {
  linkTarget,
  locate,
  parseRevFolder,
  poNoteName,
  projectNoteName,
  projectNotePath,
  revFolderName,
  revNoteName,
  revNotePath,
  today,
  wikilink,
  type ProjectLocation,
} from "./model";

type Fm = Record<string, unknown>;

/** Fields whose transitions drive automation, remembered per note path. */
interface Snapshot {
  type: string;
  rev_status?: unknown;
  opp_status?: unknown;
  work_status?: unknown;
  accepted_rev?: unknown;
  list_price?: unknown;
  multiplier?: unknown;
  sell_price?: unknown;
  cost?: unknown;
}

const TEMPLATE_DIR = "policy/templates";
const LIVE_OPP: Record<string, true> = { open: true, submitted: true, revising: true, "post-sales": true };

export interface AutomationHooks {
  /** A project's work_status/opp_status changed (after automation settled). */
  onProjectStatus(project: TFile, fm: Fm): void;
}

export class Automation {
  private readonly snapshots = new Map<string, Snapshot>();
  /** While true (migration), metadata changes only refresh snapshots. */
  suspended = false;

  constructor(
    private readonly app: App,
    private readonly hooks: AutomationHooks,
  ) {}

  /** Seed snapshots so the first observed change is compared against real prior values. */
  prime(): void {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm && locate(file.path)) this.remember(file.path, fm);
    }
  }

  forget(path: string): void {
    this.snapshots.delete(path);
  }

  rename(oldPath: string, newPath: string): void {
    const snap = this.snapshots.get(oldPath);
    if (!snap) return;
    this.snapshots.delete(oldPath);
    this.snapshots.set(newPath, snap);
  }

  async onMetadataChanged(file: TFile, fm: FrontMatterCache | undefined): Promise<void> {
    if (!fm || !locate(file.path)) return;
    const prev = this.snapshots.get(file.path);
    this.remember(file.path, fm);
    if (this.suspended) return;
    const changed = (key: keyof Snapshot) => prev !== undefined && prev[key] !== fm[key];
    switch (fm.type) {
      case "revision":
        if (changed("rev_status") && fm.rev_status === "submitted") await this.onRevSubmitted(file, fm);
        if (prev === undefined || changed("list_price") || changed("multiplier") || changed("sell_price") || changed("cost")) await this.updateMargin(file, fm);
        break;
      case "po":
        if (fm.accepted_rev && changed("accepted_rev")) await this.onPoAccepted(file, fm);
        break;
      case "project":
        if (changed("opp_status") && (fm.opp_status === "won" || fm.opp_status === "lost") && fm.work_status !== "done") {
          await this.app.fileManager.processFrontMatter(file, (f: Fm) => {
            f.work_status = "done";
          });
          return; // the write re-enters with the settled values
        }
        if (prev === undefined || changed("opp_status") || changed("work_status")) this.hooks.onProjectStatus(file, fm);
        break;
    }
  }

  /** A `Rev-N` folder appeared under a project (by hand or via the command). */
  async onRevFolderCreated(folder: TFolder): Promise<void> {
    if (this.suspended) return;
    const loc = locate(folder.path);
    if (!loc || loc.rev === null || folder.path !== `${loc.root}/${loc.area}`) return;
    await this.ensureRevNote(loc, loc.rev);
    await this.applyNewRev(loc, loc.rev);
  }

  /** Create the next `Rev-N` folder + note for the project containing `path`. */
  async newRevision(path: string): Promise<TFile | null> {
    const loc = locate(path);
    const root = loc && this.app.vault.getAbstractFileByPath(loc.root);
    if (!loc || !(root instanceof TFolder)) return null;
    const revs = root.children.map((c) => parseRevFolder(c.name)).filter((n): n is number => n !== null);
    const next = revs.length ? Math.max(...revs) + 1 : 0;
    const wasSuspended = this.suspended;
    this.suspended = true; // the folder-create event must not double-apply
    try {
      await this.app.vault.createFolder(`${loc.root}/${revFolderName(next)}`);
    } finally {
      this.suspended = wasSuspended;
    }
    const note = await this.ensureRevNote(loc, next);
    await this.applyNewRev(loc, next);
    return note;
  }

  private async applyNewRev(loc: ProjectLocation, n: number): Promise<void> {
    const root = this.app.vault.getAbstractFileByPath(loc.root);
    if (!(root instanceof TFolder)) return;
    for (const child of root.children) {
      const older = parseRevFolder(child.name);
      if (older === null || older >= n) continue;
      const note = this.app.vault.getAbstractFileByPath(revNotePath(loc.root, loc.folder, older));
      if (!(note instanceof TFile)) continue;
      await this.app.fileManager.processFrontMatter(note, (f: Fm) => {
        if (f.rev_status === "draft" || f.rev_status === "submitted") f.rev_status = "superseded";
      });
    }
    const project = this.projectFile(loc);
    if (!project) return;
    await this.app.fileManager.processFrontMatter(project, (f: Fm) => {
      f.current_rev = wikilink(revNoteName(loc.folder, n));
      if (f.opp_status === "submitted") f.opp_status = "revising";
      if (n > 0 && LIVE_OPP[String(f.opp_status)]) f.work_status = "in-progress";
    });
  }

  private async onRevSubmitted(file: TFile, fm: Fm): Promise<void> {
    if (!fm.submitted_date) {
      await this.app.fileManager.processFrontMatter(file, (f: Fm) => {
        f.submitted_date = today();
      });
    }
    const loc = locate(file.path);
    const project = loc && this.projectFile(loc);
    if (!project) return;
    await this.app.fileManager.processFrontMatter(project, (f: Fm) => {
      if (f.opp_status === "open" || f.opp_status === "revising") f.opp_status = "submitted";
      f.work_status = "done";
    });
  }

  private async onPoAccepted(file: TFile, fm: Fm): Promise<void> {
    const target = linkTarget(fm.accepted_rev);
    const rev = target ? this.app.metadataCache.getFirstLinkpathDest(target, file.path) : null;
    if (rev) {
      await this.app.fileManager.processFrontMatter(rev, (f: Fm) => {
        f.rev_status = "accepted";
      });
    }
    const loc = locate(file.path);
    const project = loc && this.projectFile(loc);
    if (!project) return;
    await this.app.fileManager.processFrontMatter(project, (f: Fm) => {
      if (f.opp_status !== "won") f.opp_status = "post-sales";
    });
  }

  /** sell_price = list_price × multiplier when unset; margin = (sell − cost) / sell, 4 decimals. */
  private async updateMargin(file: TFile, fm: Fm): Promise<void> {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const list = num(fm.list_price);
    const mult = num(fm.multiplier);
    const cost = num(fm.cost);
    const sell = num(fm.sell_price) || (list > 0 && mult > 0 ? Math.round(list * mult * 100) / 100 : 0);
    const margin = sell > 0 && cost > 0 ? Math.round(((sell - cost) / sell) * 10000) / 10000 : null;
    if (sell === num(fm.sell_price) && (margin === null || margin === fm.margin)) return;
    await this.app.fileManager.processFrontMatter(file, (f: Fm) => {
      if (sell > 0) f.sell_price = sell;
      if (margin !== null) f.margin = margin;
    });
  }

  private projectFile(loc: ProjectLocation): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(projectNotePath(loc.root, loc.folder));
    return f instanceof TFile ? f : null;
  }

  private async ensureRevNote(loc: ProjectLocation, n: number): Promise<TFile> {
    const path = revNotePath(loc.root, loc.folder, n);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    const project = this.projectFile(loc);
    const projectFm = project ? this.app.metadataCache.getFileCache(project)?.frontmatter : undefined;
    return renderTemplate(this.app, "revision", path, {
      folder: loc.folder,
      opp: String(projectFm?.opp ?? ""),
      product_type: String(projectFm?.product_type ?? (loc.kind === "MCCs" ? "MCC" : "Unit")),
      rev: String(n),
      project: projectNoteName(loc.folder),
      po: poNoteName(loc.folder),
    });
  }

  private remember(path: string, fm: Fm): void {
    this.snapshots.set(path, {
      type: String(fm.type ?? ""),
      rev_status: fm.rev_status,
      opp_status: fm.opp_status,
      work_status: fm.work_status,
      accepted_rev: fm.accepted_rev,
      list_price: fm.list_price,
      multiplier: fm.multiplier,
      sell_price: fm.sell_price,
      cost: fm.cost,
    });
  }
}

/** Render `policy/templates/<name>.md` with `{{key}}` placeholders (+ `uuid`, `date`) into `path`. */
export async function renderTemplate(app: App, name: string, path: string, vars: Record<string, string>): Promise<TFile> {
  const raw = await app.vault.adapter.read(`${TEMPLATE_DIR}/${name}.md`);
  const all: Record<string, string> = { uuid: crypto.randomUUID(), date: today(), ...vars };
  const body = raw.replace(/\{\{(\w+)\}\}/g, (m, key: string) => all[key] ?? m);
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
  return app.vault.create(path, body);
}
