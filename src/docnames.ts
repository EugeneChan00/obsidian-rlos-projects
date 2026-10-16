import { Modal, Notice, Setting, SuggestModal, type App } from "obsidian";
import { BUILTIN_TOKENS, type FieldBinding, type FieldContext, type Issue } from "./fields";
import { sanitizeName } from "./model";

/** One document-name pattern: `{token}` placeholders, rendered against the current project and rev. */
export interface DocTemplate {
  label: string;
  ext: string;
  pattern: string;
}

/** Defaults follow the names already used across `projects/` (proposal docx, SAP printouts, PO entry, KOM, …). */
export const DEFAULT_DOC_TEMPLATES: DocTemplate[] = [
  { label: "Proposal", ext: "docx", pattern: "{opp} {name} Rev {rev}" },
  { label: "SAP quote printout (to inside sales)", ext: "pdf", pattern: "{opp} {name} Rev {rev} SAPQ{sapq} SAP Quote Printout" },
  { label: "SAP sales order printout (order confirmation)", ext: "pdf", pattern: "{opp} {name} SO{sales_order} SAP SO Printout" },
  { label: "PO entry check", ext: "pdf", pattern: "{opp} {name} Rev {rev} SAPQ{sapq} PO Entry" },
  { label: "Customer PO", ext: "pdf", pattern: "{opp} {name} PO {po_number}" },
  { label: "Kick-off meeting (KOM)", ext: "docx", pattern: "{opp} {name} SO{sales_order} KOM" },
  { label: "Technical clarifications", ext: "xlsx", pattern: "{opp} {name} Rev {rev} Technical Clarifications" },
  { label: "Priced proposal (internal)", ext: "docx", pattern: "{opp} {name} Rev {rev} SAPQ{sapq} Priced" },
];

const TOKEN = /\{(\w+)\}/g;

export const docSlug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** `Label | ext | pattern` per line; the settings text format. */
export function formatDocTemplates(list: DocTemplate[]): string {
  return list.map((t) => `${t.label} | ${t.ext} | ${t.pattern}`).join("\n");
}

/** Parse the settings text; malformed lines come back as errors keyed by line. */
export function parseDocTemplates(text: string): { templates: DocTemplate[]; issues: Issue[] } {
  const templates: DocTemplate[] = [];
  const issues: Issue[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const [label, ext, ...rest] = line.split("|").map((s) => s.trim());
    const pattern = rest.join("|").trim();
    if (!label || !ext || !pattern) issues.push({ level: "error", where: `line:${i}`, message: `Line ${i + 1}: needs Label | extension | pattern — \`${line}\`` });
    else templates.push({ label, ext: ext.replace(/^\./, ""), pattern });
  });
  return { templates, issues };
}

export function isDocTemplate(v: unknown): v is DocTemplate {
  return !!v && typeof v === "object" && ["label", "ext", "pattern"].every((k) => typeof Reflect.get(v, k) === "string");
}

export function tokensOf(pattern: string): string[] {
  return [...new Set([...pattern.matchAll(TOKEN)].map((m) => m[1]!))];
}

/** Errors that make a template unusable: unknown tokens, bad braces, bad extension, duplicate names. */
export function validateTemplates(templates: DocTemplate[], fields: FieldBinding[]): Issue[] {
  const known = new Set([...Object.keys(BUILTIN_TOKENS), ...fields.map((f) => f.token)]);
  const out: Issue[] = [];
  const labels = new Map<string, number>();
  const slugs = new Map<string, number>();
  templates.forEach((t, i) => {
    const where = `template:${i}`;
    const name = `“${t.label}”`;
    if (!/^[A-Za-z0-9]+$/.test(t.ext)) out.push({ level: "error", where, message: `${name}: extension \`${t.ext}\` must be letters/digits only (e.g. docx).` });
    const stripped = t.pattern.replace(TOKEN, "");
    if (/[{}]/.test(stripped)) out.push({ level: "error", where, message: `${name}: unbalanced or invalid \`{ }\` in \`${t.pattern}\`; tokens look like {opp}.` });
    const unknown = tokensOf(t.pattern).filter((k) => !known.has(k));
    if (unknown.length) out.push({ level: "error", where, message: `${name}: unknown token${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `{${k}}`).join(", ")} — define ${unknown.length > 1 ? "them" : "it"} under Fields.` });
    const key = t.label.toLowerCase();
    const slug = docSlug(t.label);
    if (labels.has(key)) out.push({ level: "error", where, message: `${name}: duplicate label (line ${labels.get(key)! + 1}).` });
    else if (!slug) out.push({ level: "error", where, message: `${name}: label needs at least one letter or digit.` });
    else if (slugs.has(slug)) out.push({ level: "error", where, message: `${name}: command id \`doc-${slug}\` clashes with line ${slugs.get(slug)! + 1}; rename one.` });
    labels.set(key, labels.get(key) ?? i);
    if (slug && !slugs.has(slug)) slugs.set(slug, i);
  });
  return out;
}

export function renderDocName(t: DocTemplate, vars: Record<string, string>): string {
  return `${sanitizeName(t.pattern.replace(TOKEN, (_, k: string) => vars[k] ?? ""))}.${t.ext}`;
}

/** What one template needs: resolved values, tokens to ask for (with why and a suggestion), unknown tokens. */
function plan(t: DocTemplate, ctx: FieldContext, remembered: Record<string, string>) {
  const vars: Record<string, string> = {};
  const ask: { token: string; reason: string; suggestion: string }[] = [];
  const unknown: string[] = [];
  for (const k of tokensOf(t.pattern)) {
    const v = ctx.values[k];
    if (!v) unknown.push(k);
    else if (v.value) vars[k] = v.value;
    else if (remembered[k]) vars[k] = remembered[k];
    else ask.push({ token: k, reason: v.ask, suggestion: v.suggestion });
  }
  return { vars, ask, unknown };
}

export interface DocRunner {
  ctx: FieldContext;
  /** Values typed this session for this project + rev. */
  remembered: Record<string, string>;
  /** Called with typed values (after copy) so they can be saved to the notes. */
  onTyped: (typed: Record<string, string>) => Promise<void>;
}

/** Copy one template's name; asks for missing values first. */
export function runTemplate(app: App, t: DocTemplate, run: DocRunner): void {
  const { vars, ask, unknown } = plan(t, run.ctx, run.remembered);
  if (unknown.length) {
    new Notice(`“${t.label}” uses undefined token${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `{${k}}`).join(", ")}. Fix it in Settings → RLOS Projects → Document names.`, 8000);
    return;
  }
  if (!ask.length) {
    void copyName(renderDocName(t, vars));
    return;
  }
  new MissingValuesModal(app, t.label, ask, async (typed) => {
    Object.assign(run.remembered, typed);
    await copyName(renderDocName(t, { ...vars, ...typed }));
    await run.onTyped(typed);
  }).open();
}

/** Picker: every template rendered for the project; choose one to copy its file name. */
export class DocNameModal extends SuggestModal<DocTemplate> {
  constructor(
    app: App,
    private readonly templates: DocTemplate[],
    private readonly run: DocRunner,
  ) {
    super(app);
    const rev = run.ctx.rev === null ? "" : ` · Rev-${run.ctx.rev}`;
    this.setPlaceholder(`Copy a document name — ${run.ctx.loc.folder}${rev}`);
  }

  getSuggestions(query: string): DocTemplate[] {
    const q = query.toLowerCase();
    return this.templates.filter((t) => t.label.toLowerCase().includes(q) || t.ext.toLowerCase().includes(q));
  }

  renderSuggestion(t: DocTemplate, el: HTMLElement): void {
    const { vars, ask, unknown } = plan(t, this.run.ctx, this.run.remembered);
    el.createDiv({ text: `${t.label} (.${t.ext})` });
    if (unknown.length) {
      el.createEl("small", { text: `⚠ undefined ${unknown.map((k) => `{${k}}`).join(", ")} — fix in settings`, cls: "mod-warning" });
      return;
    }
    const preview = renderDocName(t, { ...vars, ...Object.fromEntries(ask.map((a) => [a.token, `‹${a.token}›`])) });
    el.createEl("small", { text: ask.length ? `${preview} — will ask for ${ask.map((a) => a.token).join(", ")}` : preview });
  }

  onChooseSuggestion(t: DocTemplate): void {
    runTemplate(this.app, t, this.run);
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
    private readonly ask: { token: string; reason: string; suggestion: string }[],
    private readonly submit: (values: Record<string, string>) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.label);
    const done = () => {
      if (this.ask.some((a) => !this.values[a.token]?.trim())) {
        new Notice("Fill every field");
        return;
      }
      this.close();
      void this.submit(Object.fromEntries(this.ask.map((a) => [a.token, this.values[a.token]!.trim()])));
    };
    this.ask.forEach((a, i) =>
      new Setting(this.contentEl)
        .setName(`{${a.token}}`)
        .setDesc(a.suggestion ? `${a.reason} — suggested value prefilled; confirm it` : a.reason)
        .addText((t) => {
          t.setValue(a.suggestion);
          this.values[a.token] = a.suggestion;
          t.onChange((v) => (this.values[a.token] = v));
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
