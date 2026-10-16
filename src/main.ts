import { Modal, Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import type { AutomationApi, Disposable, Validator } from "vault-automation/src/api";
import {
  DEFAULT_DOC_TEMPLATES,
  DOC_TOKENS,
  docContext,
  DocNameModal,
  formatDocTemplates,
  isDocTemplate,
  parseDocTemplates,
  type DocTemplate,
} from "./docnames";
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
import { RlosAdapter, type CanvasOptions } from "./rules";

const CHECK_REPORT = "spaces/reports/RLOS Check.md";
const NOTE_TYPES: Record<string, true> = { project: true, revision: true, po: true };

interface RlosSettings {
  canvas: CanvasOptions;
  docNames: DocTemplate[];
}

const DEFAULT_SETTINGS: RlosSettings = {
  canvas: { foldSubfolders: true, foldSuperseded: true, cardWidth: 600, cardHeight: 800, columns: 3 },
  docNames: DEFAULT_DOC_TEMPLATES,
};

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
  settings: RlosSettings = structuredClone(DEFAULT_SETTINGS);
  private api: AutomationApi | null = null;
  private adapter: RlosAdapter | null = null;
  private registration: Disposable | null = null;
  /** Values typed for missing document-name tokens, keyed `<project root>#<rev>`, this session. */
  private readonly docValues = new Map<string, Record<string, string>>();

  async onload(): Promise<void> {
    const saved: unknown = await this.loadData();
    const savedCanvas: unknown = saved && typeof saved === "object" && "canvas" in saved ? saved.canvas : null;
    if (savedCanvas && typeof savedCanvas === "object") {
      const c = this.settings.canvas;
      for (const key of ["foldSubfolders", "foldSuperseded"] as const) {
        const v: unknown = Reflect.get(savedCanvas, key);
        if (typeof v === "boolean") c[key] = v;
      }
      for (const key of ["cardWidth", "cardHeight", "columns"] as const) {
        const v: unknown = Reflect.get(savedCanvas, key);
        if (typeof v === "number" && Number.isFinite(v) && v > 0) c[key] = v;
      }
    }
    const savedDocs: unknown = saved && typeof saved === "object" && "docNames" in saved ? saved.docNames : null;
    if (Array.isArray(savedDocs) && savedDocs.every(isDocTemplate)) this.settings.docNames = savedDocs;
    this.addSettingTab(new RlosSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.api = automationApi(this.app);
      if (!this.api) {
        new Notice("RLOS Projects needs the Vault Automation plugin (API v1) enabled");
        return;
      }
      // The adapter must subscribe through the scoped api handed to activate(), so the engine
      // removes its subscriptions when this plugin unloads or reloads.
      this.registration = this.api.registerAdapter({
        id: "rlos",
        activate: (scoped) => {
          this.adapter = new RlosAdapter(scoped, () => this.settings.canvas);
          this.adapter.activate();
        },
      });
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
    this.addCommand({
      id: "rebuild-canvas",
      name: "Rebuild canvas layout for current project",
      checkCallback: (checking) => {
        const loc = locate(this.app.workspace.getActiveFile()?.path ?? "");
        if (!loc || !this.adapter) return false;
        if (!checking) void this.adapter.syncCanvas(loc, { rebuild: true }).then(() => new Notice(`Canvas rebuilt: ${loc.folder}`));
        return true;
      },
    });
    this.addCommand({ id: "sync-all-canvases", name: "Sync all project canvases", callback: () => void this.syncAllCanvases(false) });
    this.addCommand({ id: "rebuild-all-canvases", name: "Rebuild all project canvas layouts", callback: () => void this.syncAllCanvases(true) });
    this.addCommand({ id: "sync-all-spaces", name: "Sync window spaces for all projects", callback: () => void this.syncAllSpaces() });
    this.addCommand({ id: "check", name: "Check project frontmatter", callback: () => void this.check() });
    this.addCommand({ id: "sync-selectors", name: "Sync Custom Selectors options from schema", callback: () => void this.syncSelectors() });
    this.addCommand({
      id: "copy-document-name",
      name: "Copy document name for current project",
      checkCallback: (checking) => {
        const path = this.app.workspace.getActiveFile()?.path ?? "";
        if (!locate(path) || !this.api) return false;
        if (!checking) this.copyDocumentName(path);
        return true;
      },
    });
    this.addRibbonIcon("file-signature", "Copy document name (RLOS)", () => {
      const path = this.app.workspace.getActiveFile()?.path ?? "";
      if (!locate(path)) new Notice("Open a note or file inside a project folder first");
      else this.copyDocumentName(path);
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!locate(file.path)) return;
        menu.addItem((item) => item.setTitle("Copy document name…").setIcon("file-signature").onClick(() => this.copyDocumentName(file.path)));
      }),
    );
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

  /** Open the document-name picker for the project (and Rev-N, if any) containing `path`. */
  copyDocumentName(path: string): void {
    const loc = locate(path);
    if (!loc || !this.api) return;
    const { vars, suggested } = docContext(this.api, loc);
    // Typed values (SAP quote, sales order) belong to one rev, so they are remembered per project + rev.
    const key = `${loc.root}#${vars.rev}`;
    let remembered = this.docValues.get(key);
    if (!remembered) this.docValues.set(key, (remembered = {}));
    new DocNameModal(this.app, loc, vars, suggested, this.settings.docNames, remembered).open();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async syncAllCanvases(rebuild: boolean): Promise<void> {
    if (!this.adapter) {
      new Notice("RLOS automation is not active (Vault Automation plugin missing?)");
      return;
    }
    const locs = this.projectLocations();
    for (const loc of locs) await this.adapter.syncCanvas(loc, { rebuild });
    new Notice(`${rebuild ? "Rebuilt" : "Synced"} ${locs.length} canvases`);
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

class RlosSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: RlosProjectsPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Project canvas").setHeading();
    containerEl.createEl("p", {
      text: "RFQ, PO and current Rev-N groups stay open. These switches decide which groups the canvas folds on its own. A group you fold or unfold by hand keeps your choice.",
      cls: "setting-item-description",
    });
    const toggle = (name: string, desc: string, key: "foldSubfolders" | "foldSuperseded") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(this.plugin.settings.canvas[key]).onChange(async (value) => {
            this.plugin.settings.canvas[key] = value;
            await this.plugin.saveSettings();
            new Notice("Applying to all project canvases…");
            await this.plugin.syncAllCanvases(false);
          }),
        );
    toggle("Fold subfolder groups", "Groups for subfolders inside RFQ, Rev-N and PO start folded. Off: unfold the ones the canvas folded.", "foldSubfolders");
    toggle("Fold superseded revisions", "A Rev-N group folds once its rev is superseded. Off: unfold the ones the canvas folded.", "foldSuperseded");

    const slider = (name: string, desc: string, key: "cardWidth" | "cardHeight" | "columns", min: number, max: number, step: number) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addSlider((s) =>
          s
            .setLimits(min, max, step)
            .setValue(this.plugin.settings.canvas[key])
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.canvas[key] = value;
              await this.plugin.saveSettings();
            }),
        );
    slider("Card width", "Width of each note / attachment card. Bigger cards show more at a lower zoom.", "cardWidth", 200, 1600, 20);
    slider("Card height", "Height of each note / attachment card.", "cardHeight", 200, 2000, 20);
    slider("Cards per row", "Columns in RFQ / Rev-N / PO groups; nested groups fit as many as their width allows.", "columns", 1, 8, 1);
    new Setting(containerEl)
      .setName("Apply card layout")
      .setDesc("Re-lay out every project canvas with the current card size. Cards you moved by hand go back to the grid and folding is reset to the switches above; nodes you added yourself stay.")
      .addButton((b) =>
        b
          .setButtonText("Rebuild all canvases")
          .setWarning()
          .onClick(() => void this.plugin.syncAllCanvases(true)),
      );
    new Setting(containerEl)
      .setName("Sync all project canvases")
      .setDesc("Add or remove cards to match the folders, without moving existing ones.")
      .addButton((b) => b.setButtonText("Sync now").onClick(() => void this.plugin.syncAllCanvases(false)));

    new Setting(containerEl).setName("Document names").setHeading();
    containerEl.createEl("p", {
      text: "Templates for “Copy document name” (ribbon button, command, or right-click in a project). One per line: Label | extension | pattern. Tokens: " +
        Object.entries(DOC_TOKENS)
          .map(([k, v]) => `{${k}} ${v}`)
          .join(" · "),
      cls: "setting-item-description",
    });
    const area = containerEl.createEl("textarea", { cls: "rlos-docname-templates" });
    area.rows = 12;
    area.style.width = "100%";
    area.style.fontFamily = "var(--font-monospace)";
    area.value = formatDocTemplates(this.plugin.settings.docNames);
    area.addEventListener("change", () => {
      const { templates, invalid } = parseDocTemplates(area.value);
      if (invalid.length) {
        new Notice(`Not saved — each line needs Label | extension | pattern:\n${invalid.join("\n")}`);
        return;
      }
      this.plugin.settings.docNames = templates;
      void this.plugin.saveSettings();
    });
    new Setting(containerEl)
      .setName("Restore default document names")
      .addButton((b) =>
        b.setButtonText("Restore defaults").onClick(async () => {
          this.plugin.settings.docNames = structuredClone(DEFAULT_DOC_TEMPLATES);
          await this.plugin.saveSettings();
          area.value = formatDocTemplates(this.plugin.settings.docNames);
        }),
      );
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
