import { Modal, Notice, Setting, SuggestModal, type App } from "obsidian";
import type { AutomationApi } from "vault-automation/src/api";
import { PO, parseRevFolder, projectNotePath, revNotePath, sanitizeName, today, type ProjectLocation } from "./model";

/** One document-name pattern: `{token}` placeholders, rendered against the current project and rev. */
export interface DocTemplate {
  label: string;
  ext: string;
  pattern: string;
}

/** Defaults follow the names already used across `projects/` (proposal docx, SAP printouts, PO entry, KOM, …). */
export const DEFAULT_DOC_TEMPLATES: DocTemplate[] = [
  { label: "Proposal", ext: "docx", pattern: "{opp} {name} Rev {rev}" },
  { label: "SAP quote printout (to inside sales)", ext: "pdf", pattern: "{opp} {name} Rev {rev} SAPQ{sap} SAP Quote Printout" },
  { label: "SAP sales order printout (order confirmation)", ext: "pdf", pattern: "{opp} {name} SO{sales_order} SAP SO Printout" },
  { label: "PO entry check", ext: "pdf", pattern: "{opp} {name} Rev {rev} SAPQ{sap} PO Entry" },
  { label: "Customer PO", ext: "pdf", pattern: "{opp} {name} PO {po_number}" },
  { label: "Kick-off meeting (KOM)", ext: "docx", pattern: "{opp} {name} SO{sales_order} KOM" },
  { label: "Technical clarifications", ext: "xlsx", pattern: "{opp} {name} Rev {rev} Technical Clarifications" },
  { label: "Priced proposal (internal)", ext: "docx", pattern: "{opp} {name} Rev {rev} SAPQ{sap} Priced" },
];

export const DOC_TOKENS: Record<string, string> = {
  opp: "opportunity number",
  name: "project name",
  folder: "<opp> <name> folder",
  rev: "rev number (the Rev-N you are in, else current_rev)",
  sap: "SAP quote number (rev `sap`)",
  pcbr: "PCBR number",
  po_number: "customer PO number (PO note)",
  sales_order: "SAP sales order 650… (PO note `sales_order`, else asked)",
  end_user: "end user",
  site: "site",
  date: "today, YYYY-MM-DD",
  yymmdd: "today, YYMMDD",
};

const TOKEN = /\{(\w+)\}/g;

/** `Label | ext | pattern` per line; the settings text format. */
export function formatDocTemplates(list: DocTemplate[]): string {
  return list.map((t) => `${t.label} | ${t.ext} | ${t.pattern}`).join("\n");
}

export function parseDocTemplates(text: string): { templates: DocTemplate[]; invalid: string[] } {
  const templates: DocTemplate[] = [];
  const invalid: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [label, ext, ...rest] = line.split("|").map((s) => s.trim());
    const pattern = rest.join("|").trim();
    if (!label || !ext || !pattern) invalid.push(line);
    else templates.push({ label, ext: ext.replace(/^\./, ""), pattern });
  }
  return { templates, invalid };
}

export function isDocTemplate(v: unknown): v is DocTemplate {
  return !!v && typeof v === "object" && ["label", "ext", "pattern"].every((k) => typeof Reflect.get(v, k) === "string");
}

const scalar = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
const digits = (v: unknown): string => scalar(v).replace(/\D/g, "");

export interface DocContext {
  /** Token values; empty string = unknown (asked for). */
  vars: Record<string, string>;
  /** Prefill for asked tokens: a likely value that must still be confirmed. */
  suggested: Record<string, string>;
}

/** Token values for one project folder. */
export function docContext(api: AutomationApi, loc: ProjectLocation): DocContext {
  const project = api.props.get(projectNotePath(loc.root, loc.folder)) ?? {};
  const currentRev = /Rev-(\d+)\]\]$/.exec(scalar(project.current_rev));
  const revs = api.notes.subfolders(loc.root).map(parseRevFolder).filter((n): n is number => n !== null);
  const rev = loc.rev ?? (currentRev ? Number(currentRev[1]) : revs.length ? Math.max(...revs) : null);
  const revFm = rev === null ? {} : (api.props.get(revNotePath(loc.root, loc.folder, rev)) ?? {});
  const po = api.notes
    .list(`${loc.root}/${PO}`, { recursive: true })
    .filter((f) => f.extension === "md")
    .map((f) => api.props.get(f.path) ?? {})
    .find((fm) => fm.type === "po") ?? {};
  const date = today();
  const vars = {
    opp: digits(project.opp) || loc.folder.split(" ")[0]!,
    name: scalar(project.name) || loc.folder.replace(/^\S+\s*/, ""),
    folder: loc.folder,
    rev: rev === null ? "" : String(rev),
    // A rev can carry its own SAP quote; the project-level `sapq` may belong to another rev, so it is only a prefill.
    sap: digits(revFm.sap),
    pcbr: digits(revFm.pcbr) || digits(project.pcbr),
    po_number: scalar(po.po_number),
    sales_order: digits(po.sales_order),
    end_user: scalar(project.end_user),
    site: scalar(project.site),
    date,
    yymmdd: date.slice(2).replace(/-/g, ""),
  };
  return { vars, suggested: { sap: digits(project.sapq) } };
}

export function tokensOf(pattern: string): string[] {
  return [...new Set([...pattern.matchAll(TOKEN)].map((m) => m[1]!))];
}

export function renderDocName(t: DocTemplate, vars: Record<string, string>): string {
  const body = sanitizeName(t.pattern.replace(TOKEN, (_, k: string) => vars[k] ?? ""));
  return `${body}.${t.ext}`;
}

/** Picker: every template rendered for the project; choose one to copy its file name. */
export class DocNameModal extends SuggestModal<DocTemplate> {
  constructor(
    app: App,
    loc: ProjectLocation,
    private readonly vars: Record<string, string>,
    private readonly suggested: Record<string, string>,
    private readonly templates: DocTemplate[],
    /** Values typed for missing tokens, kept for the session per project + rev. */
    private readonly remembered: Record<string, string>,
  ) {
    super(app);
    this.setPlaceholder(`Copy a document name — ${loc.folder}${vars.rev ? ` · Rev-${vars.rev}` : ""}`);
  }

  private values(): Record<string, string> {
    const out = { ...this.vars };
    for (const [k, v] of Object.entries(this.remembered)) if (!out[k]) out[k] = v;
    return out;
  }

  getSuggestions(query: string): DocTemplate[] {
    const q = query.toLowerCase();
    return this.templates.filter((t) => t.label.toLowerCase().includes(q) || t.ext.toLowerCase().includes(q));
  }

  renderSuggestion(t: DocTemplate, el: HTMLElement): void {
    const vars = this.values();
    const missing = tokensOf(t.pattern).filter((k) => !vars[k]);
    el.createDiv({ text: `${t.label} (.${t.ext})` });
    const preview = renderDocName(
      t,
      Object.fromEntries([...Object.entries(vars), ...missing.map((k) => [k, `‹${k}›`])]),
    );
    el.createEl("small", { text: missing.length ? `${preview} — will ask for ${missing.join(", ")}` : preview, cls: "rlos-docname-preview" });
  }

  onChooseSuggestion(t: DocTemplate): void {
    const vars = this.values();
    const missing = tokensOf(t.pattern).filter((k) => !vars[k]);
    if (!missing.length) {
      void copyName(renderDocName(t, vars));
      return;
    }
    new MissingValuesModal(this.app, t.label, missing, this.suggested, (filled) => {
      Object.assign(this.remembered, filled);
      void copyName(renderDocName(t, { ...vars, ...filled }));
    }).open();
  }
}

async function copyName(name: string): Promise<void> {
  await navigator.clipboard.writeText(name);
  new Notice(`Copied: ${name}`);
}

class MissingValuesModal extends Modal {
  private readonly values: Record<string, string> = {};

  constructor(
    app: App,
    private readonly label: string,
    private readonly keys: string[],
    private readonly suggested: Record<string, string>,
    private readonly submit: (values: Record<string, string>) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.label);
    const done = () => {
      if (this.keys.some((k) => !this.values[k]?.trim())) {
        new Notice("Fill every field");
        return;
      }
      this.close();
      this.submit(Object.fromEntries(this.keys.map((k) => [k, this.values[k]!.trim()])));
    };
    this.keys.forEach((k, i) =>
      new Setting(this.contentEl)
        .setName(k)
        .setDesc(this.suggested[k] ? `${DOC_TOKENS[k] ?? ""} — prefilled from the project; confirm it matches this rev` : (DOC_TOKENS[k] ?? ""))
        .addText((t) => {
          const prefill = this.suggested[k] ?? "";
          t.setValue(prefill);
          this.values[k] = prefill;
          t.onChange((v) => (this.values[k] = v));
          t.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") done();
          });
          if (i === 0) window.setTimeout(() => t.inputEl.select(), 0);
        }),
    );
    new Setting(this.contentEl).addButton((b) => b.setButtonText("Copy name").setCta().onClick(done));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
