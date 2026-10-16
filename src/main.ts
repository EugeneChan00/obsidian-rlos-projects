import { Modal, Notice, Plugin, Setting, type App } from "obsidian";
import type { AutomationApi, Disposable, Validator } from "../../vault-automation/src/api";
import {
  KIND_FOLDERS,
  locate,
  PROJECTS_ROOT,
  projectNotePath,
  RFQ,
  sanitizeName,
  SCHEMA_PATH,
  TEMPLATES,
  templateVars,
  today,
  type KindFolder,
  type ProjectLocation,
} from "./model";
import { RlosAdapter } from "./rules";

const CHECK_REPORT = "spaces/reports/RLOS Check.md";
const NOTE_TYPES: Record<string, true> = { project: true, revision: true, po: true };

function automationApi(app: App): AutomationApi | null {
  // `app.plugins` is undocumented; narrow each hop instead of trusting a shape.
  const registry: unknown = Reflect.get(app, "plugins");
  const plugins: unknown = registry && typeof registry === "object" ? Reflect.get(registry, "plugins") : null;
  const plugin: unknown = plugins && typeof plugins === "object" ? Reflect.get(plugins, "vault-automation") : null;
  const api: unknown = plugin && typeof plugin === "object" ? Reflect.get(plugin, "api") : null;
  if (!api || typeof api !== "object" || !("version" in api) || api.version !== 1) return null;
  // Version-checked contract published by the vault-automation plugin.
  const typed = api as AutomationApi;
  return typed;
}

/** RLOS adapter: registers the RLOS rules with vault-automation and provides RLOS commands. */
export default class RlosProjectsPlugin extends Plugin {
  private api: AutomationApi | null = null;
  private adapter: RlosAdapter | null = null;
  private registration: Disposable | null = null;

  async onload(): Promise<void> {
    this.app.workspace.onLayoutReady(() => {
      this.api = automationApi(this.app);
      if (!this.api) {
        new Notice("RLOS Projects needs the Vault Automation plugin (API v1) enabled");
        return;
      }
      const adapter = new RlosAdapter(this.api);
      this.adapter = adapter;
      this.registration = this.api.registerAdapter({ id: adapter.id, activate: () => adapter.activate() });
    });

    this.addCommand({ id: "new-project", name: "New project", callback: () => new NewProjectModal(this.app, (k, o, n) => this.newProject(k, o, n)).open() });
    this.addCommand({
      id: "new-revision",
      name: "New revision for current project",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !locate(file.path) || !this.adapter) return false;
        if (!checking) void this.newRevision(file.path);
        return true;
      },
    });
    this.addCommand({
      id: "sync-canvas",
      name: "Sync canvas for current project",
      checkCallback: (checking) => {
        const loc = locate(this.app.workspace.getActiveFile()?.path ?? "");
        if (!loc || !this.adapter) return false;
        if (!checking) void this.adapter.syncCanvas(loc).then(() => new Notice(`Canvas synced: ${loc.folder}`));
        return true;
      },
    });
    this.addCommand({ id: "sync-all-canvases", name: "Sync all project canvases", callback: () => void this.syncAllCanvases() });
    this.addCommand({ id: "sync-all-spaces", name: "Sync window spaces for all projects", callback: () => void this.syncAllSpaces() });
    this.addCommand({ id: "check", name: "Check project frontmatter", callback: () => void this.check() });
    this.addCommand({ id: "sync-selectors", name: "Sync Custom Selectors options from schema", callback: () => void this.syncSelectors() });
  }

  onunload(): void {
    this.registration?.dispose();
  }

  private requireApi(): AutomationApi {
    if (!this.api) throw new Error("Vault Automation API unavailable");
    return this.api;
  }

  private projectLocations(): ProjectLocation[] {
    const api = this.requireApi();
    const out: ProjectLocation[] = [];
    for (const kind of KIND_FOLDERS) {
      for (const name of api.notes.subfolders(`${PROJECTS_ROOT}/${kind}`)) {
        const loc = locate(`${PROJECTS_ROOT}/${kind}/${name}`);
        if (loc && api.notes.file(projectNotePath(loc.root, loc.folder))) out.push(loc);
      }
    }
    return out;
  }

  private async syncAllCanvases(): Promise<void> {
    const locs = this.projectLocations();
    for (const loc of locs) await this.adapter!.syncCanvas(loc);
    new Notice(`Synced ${locs.length} canvases`);
  }

  private async syncAllSpaces(): Promise<void> {
    const api = this.requireApi();
    if (!api.spaces.available()) {
      new Notice("Window Spaces (rlos fork with API) is not enabled");
      return;
    }
    let n = 0;
    for (const loc of this.projectLocations()) {
      const path = projectNotePath(loc.root, loc.folder);
      const fm = api.props.get(path);
      if (!fm) continue;
      await this.adapter!.syncSpace(path, fm);
      n++;
    }
    new Notice(`Window spaces synced for ${n} projects`);
  }

  private async newProject(kind: KindFolder, opp: string, name: string): Promise<void> {
    const api = this.requireApi();
    const digits = opp.replace(/\D/g, "");
    const folder = `${digits || `TEMP-${today().slice(2).replace(/-/g, "")}`} ${sanitizeName(name)}`;
    const root = `${PROJECTS_ROOT}/${kind}/${folder}`;
    if (api.notes.subfolders(`${PROJECTS_ROOT}/${kind}`).includes(folder)) {
      new Notice(`Already exists: ${root}`);
      return;
    }
    await api.notes.ensureFolder(`${root}/${RFQ}`);
    const note = await api.notes.createFromTemplate(TEMPLATES.project, projectNotePath(root, folder), templateVars(kind, folder, digits));
    await this.newRevision(note.path);
    await this.app.workspace.getLeaf(true).openFile(note);
  }

  private async newRevision(path: string): Promise<void> {
    const note = await this.adapter!.newRevision(path);
    const loc = note ? locate(note) : null;
    if (!note || !loc) return;
    await this.adapter!.syncCanvas(loc);
    new Notice(`Created ${note.split("/").pop()!.replace(/\.md$/, "")}`);
  }

  private async check(): Promise<void> {
    const api = this.requireApi();
    const validator: Validator = await api.schema.load(SCHEMA_PATH);
    const rows: string[] = [];
    let checked = 0;
    for (const file of api.notes.list(PROJECTS_ROOT, { recursive: true })) {
      if (file.extension !== "md") continue;
      const fm = api.props.get(file.path);
      const type = String(fm?.type ?? "");
      if (!fm || !NOTE_TYPES[type]) continue;
      checked++;
      for (const v of validator.validate(type, fm)) rows.push(`| [[${file.path}\\|${file.basename}]] | \`${v.key}\` | ${v.message.replace(/\|/g, "\\|")} |`);
    }
    const body = [
      "---",
      "type: report",
      "---",
      "",
      `# RLOS Check — ${new Date().toLocaleString()}`,
      "",
      `${checked} notes checked against [[${SCHEMA_PATH}]], ${rows.length} violations.`,
      "",
      "| Note | Field | Problem |",
      "| --- | --- | --- |",
      ...rows,
      "",
    ].join("\n");
    const existing = api.notes.file(CHECK_REPORT);
    if (existing) await this.app.vault.modify(existing, body);
    else {
      await api.notes.ensureFolder(CHECK_REPORT.slice(0, CHECK_REPORT.lastIndexOf("/")));
      await this.app.vault.create(CHECK_REPORT, body);
    }
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
    const v = await this.requireApi().schema.load(SCHEMA_PATH);
    const options = (def: string) => v.enumOf(def).map(String).filter(Boolean);
    const selectors = [
      { name: "work_status", options: options("workStatus"), defaultFirst: true },
      { name: "opp_status", options: options("oppStatus"), defaultFirst: true },
      { name: "rev_status", options: options("revStatus"), defaultFirst: true },
      { name: "priority", options: options("priority"), defaultFirst: false },
      { name: "product_type", options: options("productType"), defaultFirst: false },
    ];
    Reflect.set(cs, "settings", { selectors });
    await cs.saveSettings.call(cs);
    new Notice("Custom Selectors options synced from schema");
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
