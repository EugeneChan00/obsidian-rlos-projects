import type { AutomationApi, CanvasGroupSpec, Frontmatter } from "../../vault-automation/src/api";
import {
  canvasPath,
  locate,
  PO,
  parseRevFolder,
  projectNotePath,
  revFolderName,
  revNoteName,
  revNotePath,
  RFQ,
  TEMPLATES,
  templateVars,
  today,
  wikilink,
  type ProjectLocation,
} from "./model";

const PROJECTS = "projects";
const CANVAS_DEBOUNCE_MS = 1500;
const ID_PREFIX = "rlos-";
const LIVE_OPP: Record<string, true> = { open: true, submitted: true, revising: true, "post-sales": true };
const PRICING_KEYS = ["list_price", "multiplier", "sell_price", "cost"];
/** Window Spaces section per work_status; only these statuses keep an active space. */
const SECTION_BY_WORK: Record<string, string> = {
  todo: "Todo",
  "in-progress": "In Progress",
  "in-review": "In Review",
};

const isType = (type: string) => (fm: Frontmatter) => fm.type === type;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** RLOS schema (policy/PROJECTS.md) expressed as rules on the schema-agnostic automation API. */
export class RlosAdapter {
  readonly id = "rlos";

  constructor(private readonly api: AutomationApi) {}

  activate(): void {
    const { api } = this;

    api.onPropertyChange({ folder: PROJECTS, where: isType("revision"), keys: ["rev_status"] }, async ({ file, fm, prev }) => {
      if (prev && fm.rev_status === "submitted" && prev.rev_status !== "submitted") await this.revSubmitted(file.path, fm);
    });
    api.onPropertyChange({ folder: PROJECTS, where: isType("revision"), keys: PRICING_KEYS }, ({ file, fm }) => this.updateMargin(file.path, fm));
    api.onPropertyChange({ folder: PROJECTS, where: isType("po"), keys: ["accepted_rev"] }, async ({ file, fm, prev }) => {
      if (prev && fm.accepted_rev) await this.poAccepted(file.path, fm);
    });
    api.onPropertyChange({ folder: PROJECTS, where: isType("project"), keys: ["opp_status", "work_status"] }, async ({ file, fm, prev, changed }) => {
      if (prev && changed.includes("opp_status") && (fm.opp_status === "won" || fm.opp_status === "lost") && fm.work_status !== "done") {
        await api.props.set(file.path, { work_status: "done" }); // re-enters with the settled values
        return;
      }
      if (prev) await this.syncSpace(file.path, fm);
    });

    api.onPathEvent({ folder: PROJECTS, types: ["create"], folders: true, pattern: /^projects\/[^/]+\/[^/]+\/Rev-\d+$/ }, async ({ path }) => {
      const loc = locate(path);
      if (loc?.rev != null) await this.applyNewRev(loc, loc.rev);
    });
    api.onPathEvent({ folder: PROJECTS }, ({ path, oldPath }) => {
      for (const p of oldPath ? [path, oldPath] : [path]) {
        const loc = locate(p);
        if (loc?.area && (loc.area === RFQ || loc.area === PO || loc.rev !== null)) api.debounce(`rlos-canvas:${loc.root}`, CANVAS_DEBOUNCE_MS, () => this.syncCanvas(loc));
      }
    });
  }

  /** Create the next `Rev-N` folder + note for the project containing `path`, then apply new-rev effects. */
  async newRevision(path: string): Promise<string | null> {
    const loc = locate(path);
    if (!loc) return null;
    const revs = this.api.notes.subfolders(loc.root).map(parseRevFolder).filter((n): n is number => n !== null);
    const next = revs.length ? Math.max(...revs) + 1 : 0;
    // The folder-create event must not apply the new-rev effects a second time.
    await this.api.batch(() => this.api.notes.ensureFolder(`${loc.root}/${revFolderName(next)}`));
    await this.applyNewRev(loc, next);
    return revNotePath(loc.root, loc.folder, next);
  }

  /** Canvas = PROJECT note + one group per RFQ / Rev-N / PO folder, with a nested group per subfolder. */
  async syncCanvas(loc: ProjectLocation, opts?: { rebuild?: boolean }): Promise<void> {
    const anchor = projectNotePath(loc.root, loc.folder);
    if (!this.api.notes.file(anchor)) return; // only folders already in the spec layout
    const sub = this.api.notes.subfolders(loc.root);
    const revs = sub.map(parseRevFolder).filter((n): n is number => n !== null).sort((a, b) => a - b);
    const groups: CanvasGroupSpec[] = [
      ...(sub.includes(RFQ) ? [this.folderGroup(loc.root, RFQ)] : []),
      ...revs.map((n) => ({
        ...this.folderGroup(loc.root, revFolderName(n)),
        collapse: this.api.props.get(revNotePath(loc.root, loc.folder, n))?.rev_status === "superseded",
      })),
      ...(sub.includes(PO) ? [this.folderGroup(loc.root, PO)] : []),
    ];
    const chain = ["anchor", ...revs.map(revFolderName), ...(sub.includes(PO) ? [PO] : [])];
    const edges: [string, string][] = [
      ...(sub.includes(RFQ) ? ([["anchor", RFQ]] as [string, string][]) : []),
      ...chain.slice(1).map((to, i): [string, string] => [chain[i]!, to]),
    ];
    await this.api.canvas.sync({ canvasPath: canvasPath(loc.root, loc.folder), idPrefix: ID_PREFIX, anchor, groups, edges }, opts);
  }

  /**
   * Mirror statuses onto the project's Window Space: a live opportunity in todo / in-progress /
   * in-review has an active space in that section; any other state archives an existing space.
   */
  async syncSpace(projectPath: string, fm: Frontmatter): Promise<void> {
    const loc = locate(projectPath);
    const project = this.api.notes.file(projectPath);
    if (!loc || !project || !this.api.spaces.available()) return;
    const section = SECTION_BY_WORK[String(fm.work_status)];
    const active = Boolean(LIVE_OPP[String(fm.opp_status)]) && section !== undefined;
    const existing = this.api.spaces.find(loc.folder);
    if (!existing) {
      if (active) await this.api.spaces.ensure(this.api.notes.file(canvasPath(loc.root, loc.folder)) ?? project, { name: loc.folder, section });
      return;
    }
    if (active && existing.sections?.[0] !== section) await this.api.spaces.setSection(existing.id, section);
    if (Boolean(existing.archived) === active) await this.api.spaces.setArchived(existing.id, !active);
  }

  /** Group for `<root>/<key>`: its direct files, plus a nested group per non-empty subfolder (key = relative path). */
  private folderGroup(root: string, key: string): CanvasGroupSpec {
    const folder = `${root}/${key}`;
    return {
      key,
      label: key.split("/").pop()!,
      files: this.api.notes.list(folder).map((f) => f.path),
      groups: this.api.notes
        .subfolders(folder)
        .sort((a, b) => a.localeCompare(b))
        .filter((name) => this.api.notes.list(`${folder}/${name}`, { recursive: true }).length > 0)
        .map((name) => this.folderGroup(root, `${key}/${name}`)),
    };
  }

  private async applyNewRev(loc: ProjectLocation, n: number): Promise<void> {
    const { api } = this;
    const note = revNotePath(loc.root, loc.folder, n);
    const projectPath = projectNotePath(loc.root, loc.folder);
    if (!api.notes.file(note)) {
      await api.notes.createFromTemplate(TEMPLATES.revision, note, { ...templateVars(loc.kind, loc.folder, String(api.props.get(projectPath)?.opp ?? "")), rev: n });
    }
    for (const older of api.notes.subfolders(loc.root).map(parseRevFolder)) {
      if (older === null || older >= n) continue;
      const path = revNotePath(loc.root, loc.folder, older);
      const status = api.props.get(path)?.rev_status;
      if (status === "draft" || status === "submitted") await api.props.set(path, { rev_status: "superseded" });
    }
    if (!api.notes.file(projectPath)) return;
    await api.props.set(projectPath, (f) => {
      f.current_rev = wikilink(revNoteName(loc.folder, n));
      if (f.opp_status === "submitted") f.opp_status = "revising";
      if (n > 0 && LIVE_OPP[String(f.opp_status)]) f.work_status = "in-progress";
    });
  }

  private async revSubmitted(path: string, fm: Frontmatter): Promise<void> {
    if (!fm.submitted_date) await this.api.props.set(path, { submitted_date: today() });
    const loc = locate(path);
    const project = loc && projectNotePath(loc.root, loc.folder);
    if (!project || !this.api.notes.file(project)) return;
    await this.api.props.set(project, (f) => {
      if (f.opp_status === "open" || f.opp_status === "revising") f.opp_status = "submitted";
      f.work_status = "done";
    });
  }

  private async poAccepted(path: string, fm: Frontmatter): Promise<void> {
    const rev = this.api.notes.resolveLink(fm.accepted_rev, path);
    if (rev) await this.api.props.set(rev.path, { rev_status: "accepted" });
    const loc = locate(path);
    const project = loc && projectNotePath(loc.root, loc.folder);
    if (!project || !this.api.notes.file(project)) return;
    await this.api.props.set(project, (f) => {
      if (f.opp_status !== "won") f.opp_status = "post-sales";
    });
  }

  /** sell_price = list_price × multiplier when unset; margin = (sell − cost) / sell, 4 decimals. */
  private async updateMargin(path: string, fm: Frontmatter): Promise<void> {
    const list = num(fm.list_price);
    const mult = num(fm.multiplier);
    const cost = num(fm.cost);
    const sell = num(fm.sell_price) || (list > 0 && mult > 0 ? Math.round(list * mult * 100) / 100 : 0);
    const margin = sell > 0 && cost > 0 ? Math.round(((sell - cost) / sell) * 10000) / 10000 : undefined;
    await this.api.props.set(path, { ...(sell > 0 ? { sell_price: sell } : {}), ...(margin !== undefined ? { margin } : {}) });
  }
}
