import { Modal, Notice, Plugin, Setting, TFile, TFolder, type App, type TAbstractFile } from "obsidian";
import { Automation, renderTemplate } from "./automation";
import { syncProjectCanvas } from "./canvas";
import { applyPlan, buildPlan, PLAN_PATH, renderPlan, REPORT_PATH } from "./migrate";
import {
  KIND_FOLDERS,
  locate,
  parseRevFolder,
  PRODUCT_TYPE,
  PROJECTS_ROOT,
  projectNotePath,
  revNotePath,
  RFQ,
  sanitizeName,
  today,
  type KindFolder,
  type ProjectLocation,
} from "./model";
import { ProjectSchema, type NoteType } from "./schema";
import { syncProjectSpace } from "./spaces";

const CHECK_REPORT = "spaces/reports/RLOS Check.md";
const CANVAS_DEBOUNCE_MS = 1500;
const NOTE_TYPES: Record<string, NoteType> = { project: "project", revision: "revision", po: "po" };

export default class RlosProjectsPlugin extends Plugin {
  private schema!: ProjectSchema;
  private automation!: Automation;
  private readonly canvasTimers = new Map<string, number>();

  async onload(): Promise<void> {
    this.schema = await ProjectSchema.load(this.app);
    this.automation = new Automation(this.app, {
      onProjectStatus: (file, fm) => void syncProjectSpace(this.app, file, fm),
    });

    this.addCommand({ id: "new-project", name: "New project", callback: () => new NewProjectModal(this.app, (k, o, n) => this.newProject(k, o, n)).open() });
    this.addCommand({
      id: "new-revision",
      name: "New revision for current project",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !locate(file.path)) return false;
        if (!checking) void this.newRevision(file.path);
        return true;
      },
    });
    this.addCommand({
      id: "sync-canvas",
      name: "Sync canvas for current project",
      checkCallback: (checking) => {
        const loc = locate(this.app.workspace.getActiveFile()?.path ?? "");
        if (!loc) return false;
        if (!checking) void this.syncCanvas(loc).then(() => new Notice(`Canvas synced: ${loc.folder}`));
        return true;
      },
    });
    this.addCommand({ id: "sync-all-canvases", name: "Sync all project canvases", callback: () => void this.syncAllCanvases() });
    this.addCommand({ id: "sync-all-spaces", name: "Sync window spaces for all projects", callback: () => void this.syncAllSpaces() });
    this.addCommand({ id: "check", name: "Check project frontmatter", callback: () => void this.check() });
    this.addCommand({ id: "sync-selectors", name: "Sync Custom Selectors options from schema", callback: () => void this.syncSelectors() });
    this.addCommand({ id: "migrate-plan", name: "Plan project layout migration (dry run)", callback: () => void this.migratePlan() });
    this.addCommand({ id: "migrate-apply", name: "Apply project layout migration", callback: () => void this.migrateApply() });

    this.app.workspace.onLayoutReady(() => {
      this.automation.prime();
      this.registerEvent(this.app.metadataCache.on("changed", (file, _data, cache) => void this.automation.onMetadataChanged(file, cache.frontmatter)));
      this.registerEvent(this.app.vault.on("create", (f) => void this.onCreate(f)));
      this.registerEvent(this.app.vault.on("delete", (f) => {
        this.automation.forget(f.path);
        this.queueCanvas(f.path);
      }));
      this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
        this.automation.rename(oldPath, f.path);
        this.queueCanvas(oldPath);
        this.queueCanvas(f.path);
      }));
    });
  }

  onunload(): void {
    for (const t of this.canvasTimers.values()) window.clearTimeout(t);
  }

  private async onCreate(f: TAbstractFile): Promise<void> {
    if (f instanceof TFolder) await this.automation.onRevFolderCreated(f);
    this.queueCanvas(f.path);
  }

  /** Debounced canvas sync for the project owning `path`, when the path sits in RFQ/, Rev-N/ or PO/. */
  private queueCanvas(path: string): void {
    if (this.automation.suspended) return;
    const loc = locate(path);
    if (!loc || !loc.area || !(loc.area === RFQ || loc.area === "PO" || loc.rev !== null)) return;
    const prev = this.canvasTimers.get(loc.root);
    if (prev !== undefined) window.clearTimeout(prev);
    this.canvasTimers.set(
      loc.root,
      window.setTimeout(() => {
        this.canvasTimers.delete(loc.root);
        void this.syncCanvas(loc);
      }, CANVAS_DEBOUNCE_MS),
    );
  }

  private async syncCanvas(loc: ProjectLocation): Promise<void> {
    const root = this.app.vault.getAbstractFileByPath(loc.root);
    if (!(root instanceof TFolder)) return;
    const collapseRevs = new Set<number>();
    for (const c of root.children) {
      const rev = parseRevFolder(c.name);
      if (rev === null) continue;
      const note = this.app.vault.getAbstractFileByPath(revNotePath(loc.root, loc.folder, rev));
      if (note instanceof TFile && this.app.metadataCache.getFileCache(note)?.frontmatter?.rev_status === "superseded") collapseRevs.add(rev);
    }
    await syncProjectCanvas(this.app, loc, { collapseRevs });
  }

  private projectLocations(): ProjectLocation[] {
    const out: ProjectLocation[] = [];
    for (const kind of KIND_FOLDERS) {
      const folder = this.app.vault.getAbstractFileByPath(`${PROJECTS_ROOT}/${kind}`);
      if (!(folder instanceof TFolder)) continue;
      for (const c of folder.children) {
        const loc = c instanceof TFolder ? locate(c.path) : null;
        if (loc && this.app.vault.getAbstractFileByPath(projectNotePath(loc.root, loc.folder))) out.push(loc);
      }
    }
    return out;
  }

  private async syncAllCanvases(): Promise<void> {
    const locs = this.projectLocations();
    for (const loc of locs) await this.syncCanvas(loc);
    new Notice(`Synced ${locs.length} canvases`);
  }

  private async syncAllSpaces(): Promise<void> {
    let n = 0;
    for (const loc of this.projectLocations()) {
      const file = this.app.vault.getAbstractFileByPath(projectNotePath(loc.root, loc.folder));
      const fm = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
      if (file instanceof TFile && fm) {
        await syncProjectSpace(this.app, file, fm);
        n++;
      }
    }
    new Notice(`Window spaces synced for ${n} projects`);
  }

  private async newProject(kind: KindFolder, opp: string, name: string): Promise<void> {
    const folder = `${opp.replace(/\D/g, "") || `TEMP-${today().slice(2).replace(/-/g, "")}`} ${sanitizeName(name)}`;
    const root = `${PROJECTS_ROOT}/${kind}/${folder}`;
    if (this.app.vault.getAbstractFileByPath(root)) {
      new Notice(`Already exists: ${root}`);
      return;
    }
    await this.app.vault.createFolder(`${root}/${RFQ}`);
    const note = await renderTemplate(this.app, "project", projectNotePath(root, folder), {
      folder,
      opp: opp.replace(/\D/g, ""),
      name: sanitizeName(name),
      product_type: PRODUCT_TYPE[kind],
    });
    await this.newRevision(note.path);
    await this.app.workspace.getLeaf(true).openFile(note);
  }

  private async newRevision(path: string): Promise<void> {
    const note = await this.automation.newRevision(path);
    if (!note) return;
    const loc = locate(note.path);
    if (loc) await this.syncCanvas(loc);
    new Notice(`Created ${note.basename}`);
  }

  private async check(): Promise<void> {
    const rows: string[] = [];
    let checked = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!locate(file.path)) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const type = NOTE_TYPES[String(fm?.type ?? "")];
      if (!fm || !type) continue;
      checked++;
      for (const v of this.schema.validate(type, fm)) rows.push(`| [[${file.path}\\|${file.basename}]] | \`${v.key}\` | ${v.message.replace(/\|/g, "\\|")} |`);
    }
    const body = [
      "---",
      "type: report",
      "---",
      "",
      `# RLOS Check — ${new Date().toLocaleString()}`,
      "",
      `${checked} notes checked against [[policy/schemas/projects.schema.json]], ${rows.length} violations.`,
      "",
      "| Note | Field | Problem |",
      "| --- | --- | --- |",
      ...rows,
      "",
    ].join("\n");
    await this.writeNote(CHECK_REPORT, body);
    new Notice(`RLOS check: ${rows.length} violations in ${checked} notes`);
  }

  private async syncSelectors(): Promise<void> {
    const registry: unknown = Reflect.get(this.app, "plugins");
    const plugins: unknown = registry && typeof registry === "object" ? Reflect.get(registry, "plugins") : null;
    const cs: unknown = plugins && typeof plugins === "object" ? Reflect.get(plugins, "custom-selectors") : null;
    if (!cs || typeof cs !== "object" || !("settings" in cs) || !("saveSettings" in cs) || typeof cs.saveSettings !== "function") {
      new Notice("Custom Selectors is not enabled");
      return;
    }
    const s = this.schema;
    const selectors = [
      { name: "work_status", options: s.enumOf("workStatus"), defaultFirst: true },
      { name: "opp_status", options: s.enumOf("oppStatus"), defaultFirst: true },
      { name: "rev_status", options: s.enumOf("revStatus"), defaultFirst: true },
      { name: "priority", options: s.enumOf("priority").filter(Boolean), defaultFirst: false },
      { name: "product_type", options: s.enumOf("productType"), defaultFirst: false },
    ];
    Reflect.set(cs, "settings", { selectors });
    await cs.saveSettings.call(cs);
    new Notice("Custom Selectors options synced from schema");
  }

  private async migratePlan(): Promise<void> {
    const plan = buildPlan(this.app);
    await this.writeNote(PLAN_PATH, renderPlan(plan, `Migration plan — ${new Date().toLocaleString()}`));
    new Notice(`Migration plan: ${plan.projects.length} projects, ${plan.unresolved.length} unresolved`);
  }

  private async migrateApply(): Promise<void> {
    if (!this.app.vault.getAbstractFileByPath(PLAN_PATH)) {
      new Notice("Run the dry run first and review MIGRATION-PLAN.md");
      return;
    }
    const plan = buildPlan(this.app);
    const log: string[] = [];
    this.automation.suspended = true;
    try {
      await applyPlan(this.app, plan, (line) => log.push(line));
    } finally {
      this.automation.suspended = false;
    }
    this.automation.prime();
    for (const loc of this.projectLocations()) await this.syncCanvas(loc);
    const failed = log.filter((l) => l.startsWith("FAIL")).length;
    await this.writeNote(
      REPORT_PATH,
      [`# Migration report — ${new Date().toLocaleString()}`, "", `${plan.projects.length} projects, ${failed} failed.`, "", "```", ...log, "```", "", renderPlan(plan, "Applied plan")].join("\n"),
    );
    new Notice(`Migration applied: ${failed} failures — see ${REPORT_PATH}`);
  }

  private async writeNote(path: string, body: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, body);
      return;
    }
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
    await this.app.vault.create(path, body);
  }
}

class NewProjectModal extends Modal {
  private kind: KindFolder = "MCCs";
  private opp = "";
  private name = "";

  constructor(
    app: App,
    private readonly submit: (kind: KindFolder, opp: string, name: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("New project");
    new Setting(this.contentEl).setName("Kind").addDropdown((d) =>
      d.addOptions({ MCCs: "MCC", Units: "Unit" }).setValue(this.kind).onChange((v) => {
        this.kind = v === "Units" ? "Units" : "MCCs";
      }),
    );
    new Setting(this.contentEl).setName("Opportunity number").setDesc("Leave blank for a TEMP project").addText((t) => t.onChange((v) => (this.opp = v)));
    new Setting(this.contentEl).setName("Name").addText((t) => t.onChange((v) => (this.name = v)));
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Create").setCta().onClick(() => {
        if (!sanitizeName(this.name)) {
          new Notice("Name is required");
          return;
        }
        this.close();
        void this.submit(this.kind, this.opp, this.name);
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
