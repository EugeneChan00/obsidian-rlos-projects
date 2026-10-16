import { Modal, Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import type { AutomationApi, Disposable, Validator } from "vault-automation/src/api";
import {
  DEFAULT_DOC_TEMPLATES,
  docSlug,
  DocNameModal,
  formatDocTemplates,
  isDocTemplate,
  parseDocTemplates,
  runTemplate,
  validateTemplates,
  type DocRunner,
  type DocTemplate,
} from "./docnames";
import {
  BUILTIN_TOKENS,
  buildPropertyIndex,
  DEFAULT_FIELDS,
  isFieldBinding,
  NOTE_KINDS,
  registerPropertyTypes,
  resolveFields,
  saveBack,
  validateFields,
  type FieldBinding,
  type Issue,
  type NoteKind,
  type PropertyIndex,
} from "./fields";
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
import { syncQuickAddMenu, type MenuEntry } from "./quickmenu";
import { RlosAdapter, type CanvasOptions } from "./rules";
import { ChangeStatusModal } from "./status";

const CHECK_REPORT = "spaces/reports/RLOS Check.md";
const NOTE_TYPES: Record<string, true> = { project: true, revision: true, po: true };

interface RlosSettings {
  canvas: CanvasOptions;
  docNames: DocTemplate[];
  fields: FieldBinding[];
  /** Write values typed for missing tokens back to their bound properties. */
  saveTyped: boolean;
}

const DEFAULT_SETTINGS: RlosSettings = {
  canvas: { foldSubfolders: true, foldSuperseded: true, cardWidth: 600, cardHeight: 800, columns: 3 },
  docNames: DEFAULT_DOC_TEMPLATES,
  fields: DEFAULT_FIELDS,
  saveTyped: true,
};

const NOT_IN_PROJECT = "Open a note or file inside a project folder first";

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
  /** Ids of the per-template `doc-*` commands currently registered. */
  private docCommandIds: string[] = [];
  /** Problems in the saved document-name configuration, shown in settings. */
  configIssues: Issue[] = [];

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
    else if (savedDocs !== null) this.configIssues.push({ level: "error", where: "load", message: "Saved document names were malformed; defaults are in use until you save." });
    const savedFields: unknown = saved && typeof saved === "object" && "fields" in saved ? saved.fields : null;
    if (Array.isArray(savedFields) && savedFields.every(isFieldBinding)) this.settings.fields = savedFields;
    else if (savedFields !== null) this.configIssues.push({ level: "error", where: "load", message: "Saved fields were malformed; defaults are in use until you save." });
    const savedTyped: unknown = saved && typeof saved === "object" && "saveTyped" in saved ? saved.saveTyped : null;
    if (typeof savedTyped === "boolean") this.settings.saveTyped = savedTyped;
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
      this.registerDocCommands();
      const index = buildPropertyIndex(this.app, this.api);
      this.configIssues.push(...validateFields(this.settings.fields, index), ...validateTemplates(this.settings.docNames, this.settings.fields));
      if (this.configIssues.some((i) => i.level === "error")) new Notice("RLOS Projects: document-name settings have errors — see Settings → RLOS Projects", 8000);
      else registerPropertyTypes(this.app, this.settings.fields, index);
      void this.syncMenu(false);
    });

    this.addCommand({ id: "new-project", name: "New project", callback: () => new NewProjectModal(this.app, (k, o, n) => this.newProject(k, o, n)).open() });
    this.addCommand({
      id: "new-revision",
      name: "New revision for current project",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !locate(file.path)) new Notice(NOT_IN_PROJECT);
        else if (!this.adapter) new Notice("RLOS automation is not active (Vault Automation plugin missing?)");
        else void this.newRevision(file.path);
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
    this.addCommand({ id: "copy-document-name", name: "Copy document name for current project", callback: () => this.copyDocumentName(this.activePath()) });
    this.addCommand({ id: "change-status", name: "Change status for current project", callback: () => void this.changeStatus(this.activePath()) });
    this.addCommand({ id: "sync-quick-menu", name: "Sync Alt+Q (QuickAdd) menu", callback: () => void this.syncMenu(true) });
    this.addRibbonIcon("file-signature", "Copy document name (RLOS)", () => this.copyDocumentName(this.activePath()));
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

  private activePath(): string {
    return this.app.workspace.getActiveFile()?.path ?? "";
  }

  /** Context for the project (and Rev-N, if any) containing `path`, plus this session's typed values. */
  private docRunner(path: string): DocRunner | null {
    const loc = locate(path);
    if (!loc) {
      new Notice(NOT_IN_PROJECT);
      return null;
    }
    if (!this.api) {
      new Notice("RLOS Projects needs the Vault Automation plugin (API v1) enabled");
      return null;
    }
    const api = this.api;
    const ctx = resolveFields(api, loc, this.settings.fields);
    // Typed values (SAP quote, sales order) belong to one rev, so they are remembered per project + rev.
    const key = `${loc.root}#${ctx.rev ?? ""}`;
    let remembered = this.docValues.get(key);
    if (!remembered) this.docValues.set(key, (remembered = {}));
    return {
      ctx,
      remembered,
      onTyped: async (typed) => {
        if (!this.settings.saveTyped) return;
        const { saved, skipped } = await saveBack(this.app, api, ctx, this.settings.fields, typed);
        if (saved.length) new Notice(`Saved ${saved.join(", ")}`);
        if (skipped.length) new Notice(`Not saved: ${skipped.join("; ")}`, 6000);
      },
    };
  }

  /** Open the document-name picker for the project containing `path`. */
  copyDocumentName(path: string): void {
    const run = this.docRunner(path);
    if (run) new DocNameModal(this.app, this.settings.docNames, run).open();
  }

  private async changeStatus(path: string): Promise<void> {
    const run = this.docRunner(path);
    if (!run || !this.api) return;
    new ChangeStatusModal(this.app, this.api, run.ctx, await this.api.schema.load(SCHEMA_PATH)).open();
  }

  /** One `doc-<slug>` command per template, so each can be bound to a hotkey or the Alt+Q menu. */
  private registerDocCommands(): void {
    for (const id of this.docCommandIds) this.removeCommand(id);
    this.docCommandIds = [];
    for (const t of this.settings.docNames) {
      const id = `doc-${docSlug(t.label)}`;
      if (this.docCommandIds.includes(id)) continue;
      this.addCommand({
        id,
        name: `Copy document name: ${t.label}`,
        callback: () => {
          const run = this.docRunner(this.activePath());
          if (run) runTemplate(this.app, t, run);
        },
      });
      this.docCommandIds.push(id);
    }
  }

  private menuEntries(): MenuEntry[] {
    const cmd = (id: string, name: string, command: string): MenuEntry => ({ id: `rlos-${id}`, name, step: { type: "Obsidian", commandId: `${this.manifest.id}:${command}` } });
    return [
      cmd("new-project", "New Project", "new-project"),
      cmd("new-revision", "New Revision", "new-revision"),
      cmd("change-status", "Change Status", "change-status"),
      { id: "rlos-add-task", name: "Add Task", step: { type: "UserScript", path: "vault-kit/scripts/add_task.js" } },
      cmd("copy-document-name", "Copy Document Name…", "copy-document-name"),
      ...this.settings.docNames.map((t) => cmd(`doc-${docSlug(t.label)}`, `Doc Name: ${t.label}`, `doc-${docSlug(t.label)}`)),
    ];
  }

  /** Keep the RLOS entries in QuickAdd's Alt+Q menu in step with the commands and templates. */
  async syncMenu(report: boolean): Promise<void> {
    try {
      const result = await syncQuickAddMenu(this.app, this.menuEntries());
      if (report || result === "updated")
        new Notice(
          result === "quickadd-missing"
            ? "QuickAdd is not installed; the Alt+Q menu needs it (Community plugins → QuickAdd)"
            : result === "updated"
              ? "Alt+Q (QuickAdd) menu updated with RLOS entries"
              : "Alt+Q (QuickAdd) menu already up to date",
        );
    } catch (e) {
      new Notice(`Alt+Q menu not updated: ${e instanceof Error ? e.message : String(e)}`, 8000);
    }
  }

  propertyIndex(): PropertyIndex | null {
    return this.api ? buildPropertyIndex(this.app, this.api) : null;
  }

  /** Validate and apply fields + templates. Nothing is saved while any error remains. */
  async applyDocConfig(fields: FieldBinding[], templates: DocTemplate[]): Promise<Issue[]> {
    const index = this.propertyIndex();
    const issues = [...(index ? validateFields(fields, index) : []), ...validateTemplates(templates, fields)];
    if (issues.some((i) => i.level === "error")) return issues;
    this.settings.fields = fields;
    this.settings.docNames = templates;
    this.configIssues = [];
    await this.saveSettings();
    if (index) registerPropertyTypes(this.app, fields, index);
    this.registerDocCommands();
    await this.syncMenu(false);
    return issues;
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

    this.renderDocConfig(containerEl);
  }

  // Draft of the document-name configuration; applied (validated + saved) after each edit.
  private fields: FieldBinding[] = [];
  private templatesText = "";
  private index: PropertyIndex | null = null;
  private fieldIssueEls: HTMLElement[] = [];
  private templateIssuesEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private fieldsEl: HTMLElement | null = null;

  private renderDocConfig(containerEl: HTMLElement): void {
    this.fields = structuredClone(this.plugin.settings.fields);
    this.templatesText = formatDocTemplates(this.plugin.settings.docNames);
    this.index = this.plugin.propertyIndex();

    new Setting(containerEl).setName("Document names").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "“Copy document name” (ribbon button, Alt+Q menu, command, or right-click in a project) renders these templates for the current project and rev. Changes save as soon as they are valid; while anything below is red, the last valid configuration stays in use.",
    });
    this.statusEl = containerEl.createDiv({ cls: "setting-item-description" });
    for (const issue of this.plugin.configIssues.filter((i) => i.where === "load")) this.issueLine(containerEl, issue);

    new Setting(containerEl).setName("Fields").setDesc(
      `Each {token} reads one property from the project, the rev (Rev-N you are in, else current_rev) or the PO note. Property names are frontmatter keys and are case-sensitive; the suggestions list the exact keys your notes use. Built-in tokens: ${Object.entries(BUILTIN_TOKENS)
        .map(([k, v]) => `{${k}} ${v}`)
        .join(" · ")}.`,
    );
    if (!this.index) containerEl.createDiv({ cls: "mod-warning", text: "Vault Automation is not active, so property names cannot be checked against your notes." });
    this.datalists(containerEl);
    this.fieldsEl = containerEl.createDiv();
    this.renderFields();
    new Setting(containerEl)
      .addButton((b) =>
        b.setButtonText("Add field").onClick(() => {
          this.fields.push({ token: "", note: "project", property: "", digits: false, prefill: "" });
          this.renderFields();
          void this.apply();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Restore default fields").onClick(() => {
          this.fields = structuredClone(DEFAULT_FIELDS);
          this.renderFields();
          void this.apply();
        }),
      );
    new Setting(containerEl)
      .setName("Save typed values to notes")
      .setDesc("When a value is missing (SAP quote on the rev, sales order on the PO) and you type it, write it to the bound property so you only type it once.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.saveTyped).onChange(async (v) => {
          this.plugin.settings.saveTyped = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Templates").setDesc("One per line: Label | extension | pattern, e.g. Proposal | docx | {opp} {name} Rev {rev}");
    const area = containerEl.createEl("textarea", { cls: "rlos-docname-templates" });
    area.rows = 10;
    area.style.width = "100%";
    area.style.fontFamily = "var(--font-monospace)";
    area.value = this.templatesText;
    area.addEventListener("input", () => {
      this.templatesText = area.value;
      this.showIssues(this.validate());
    });
    area.addEventListener("change", () => void this.apply());
    this.templateIssuesEl = containerEl.createDiv();
    new Setting(containerEl)
      .addButton((b) =>
        b.setButtonText("Restore default templates").onClick(() => {
          this.templatesText = area.value = formatDocTemplates(DEFAULT_DOC_TEMPLATES);
          void this.apply();
        }),
      )
      .addButton((b) => b.setButtonText("Sync Alt+Q menu").onClick(() => void this.plugin.syncMenu(true)));
    this.showIssues(this.validate());
  }

  /** `<datalist>`s of exact property keys per note kind (most used first) for the property inputs. */
  private datalists(containerEl: HTMLElement): void {
    for (const kind of NOTE_KINDS) {
      const list = containerEl.createEl("datalist", { attr: { id: `rlos-props-${kind}` } });
      const keys = this.index ? [...this.index.keys[kind].entries()].sort((a, b) => b[1] - a[1]) : [];
      for (const [k, n] of keys) list.createEl("option", { attr: { value: k, label: `${n} ${kind} notes` } });
    }
    const prefill = containerEl.createEl("datalist", { attr: { id: "rlos-prefill" } });
    for (const k of Object.keys(BUILTIN_TOKENS)) prefill.createEl("option", { attr: { value: k, label: "built-in" } });
    for (const [k, n] of this.index ? [...this.index.keys.project.entries()].sort((a, b) => b[1] - a[1]) : [])
      prefill.createEl("option", { attr: { value: k, label: `${n} project notes` } });
  }

  private renderFields(): void {
    const el = this.fieldsEl;
    if (!el) return;
    el.empty();
    this.fieldIssueEls = [];
    this.fields.forEach((f, i) => {
      const row = new Setting(el).setClass("rlos-field-row");
      row.addText((t) => {
        t.setPlaceholder("token").setValue(f.token).onChange((v) => {
          f.token = v;
          this.showIssues(this.validate());
        });
        t.inputEl.size = 12;
        t.inputEl.addEventListener("change", () => void this.apply());
      });
      row.addDropdown((d) =>
        d
          .addOptions({ project: "project", revision: "rev", po: "PO" })
          .setValue(f.note)
          .onChange((v) => {
            f.note = (NOTE_KINDS as readonly string[]).includes(v) ? (v as NoteKind) : "project";
            const input = row.controlEl.querySelector<HTMLInputElement>("input.rlos-prop");
            input?.setAttr("list", `rlos-props-${f.note}`);
            void this.apply();
          }),
      );
      row.addText((t) => {
        t.setPlaceholder("property").setValue(f.property).onChange((v) => {
          f.property = v;
          this.showIssues(this.validate());
        });
        t.inputEl.addClass("rlos-prop");
        t.inputEl.setAttr("list", `rlos-props-${f.note}`);
        t.inputEl.size = 14;
        t.inputEl.addEventListener("change", () => void this.apply());
      });
      row.addText((t) => {
        t.setPlaceholder("prefill (optional)").setValue(f.prefill).onChange((v) => {
          f.prefill = v;
          this.showIssues(this.validate());
        });
        t.inputEl.setAttr("list", "rlos-prefill");
        t.inputEl.size = 12;
        t.inputEl.addEventListener("change", () => void this.apply());
      });
      row.addToggle((t) =>
        t
          .setTooltip("Digits only")
          .setValue(f.digits)
          .onChange((v) => {
            f.digits = v;
            void this.apply();
          }),
      );
      row.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("Remove field")
          .onClick(() => {
            this.fields.splice(i, 1);
            this.renderFields();
            void this.apply();
          }),
      );
      this.fieldIssueEls.push(el.createDiv());
    });
  }

  private validate(): Issue[] {
    const parsed = parseDocTemplates(this.templatesText);
    return [...(this.index ? validateFields(this.fields, this.index) : []), ...parsed.issues, ...validateTemplates(parsed.templates, this.fields)];
  }

  private issueLine(parent: HTMLElement, issue: Issue): void {
    const line = parent.createDiv({ cls: issue.level === "error" ? "mod-warning" : "setting-item-description" });
    line.style.margin = "0 0 6px 0";
    line.createSpan({ text: `${issue.level === "error" ? "✖" : "⚠"} ${issue.message} ` });
    const fix = issue.fix;
    const row = /^field:(\d+)$/.exec(issue.where);
    if (fix && row)
      line.createEl("button", { text: fix.label }).addEventListener("click", () => {
        this.fields[Number(row[1])] = fix.binding;
        this.renderFields();
        void this.apply();
      });
  }

  private showIssues(issues: Issue[]): void {
    this.fieldIssueEls.forEach((el) => el.empty());
    this.templateIssuesEl?.empty();
    for (const issue of issues) {
      const row = /^field:(\d+)$/.exec(issue.where);
      const parent = row ? this.fieldIssueEls[Number(row[1])] : this.templateIssuesEl;
      if (parent) this.issueLine(parent, issue);
    }
    const errors = issues.filter((i) => i.level === "error").length;
    this.statusEl?.setText(errors ? `✖ ${errors} error${errors > 1 ? "s" : ""} — not saved; the last valid configuration is still in use.` : "✔ Configuration valid.");
    this.statusEl?.toggleClass("mod-warning", errors > 0);
  }

  /** Validate the draft; save it (and refresh commands + Alt+Q menu) only when it has no errors. */
  private async apply(): Promise<void> {
    const parsed = parseDocTemplates(this.templatesText);
    if (parsed.issues.length) {
      this.showIssues(this.validate());
      return;
    }
    const issues = await this.plugin.applyDocConfig(structuredClone(this.fields), parsed.templates);
    this.showIssues([...issues, ...parsed.issues]);
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
