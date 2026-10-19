import { Modal, Notice, Setting, parseYaml, type App, type TextComponent } from "obsidian";
import { sanitizeName, type KindFolder } from "./model";

type Frontmatter = Record<string, unknown>;

/** What a pasted payload writes: project note keys, first/new revision note keys, and a Revision Reason body section. */
export interface Intake {
  project: Frontmatter;
  rev: Frontmatter;
  reason: string;
}

/** Keys the plugin owns on a new note; a pasted value for them is never written. */
const OWNED = new Set(["type", "uuid", "project", "canvas", "aliases", "rev", "opp", "name", "product_type", "kind", "current_rev"]);

/** Revision-note keys; in a New project payload they go to Rev-0. */
const REV_KEYS = new Set(["rev_status", "submitted_date", "sap", "list_price", "multiplier", "sell_price", "cost", "excel_reference"]);

/** Old flat `status` (new_project.js) → current project statuses, or a Rev-0 status. */
const LEGACY_PROJECT_STATUS: Record<string, Intake> = {
  intake: { project: { work_status: "backlog", opp_status: "open" }, rev: {}, reason: "" },
  todo: { project: { work_status: "todo", opp_status: "open" }, rev: {}, reason: "" },
  ongoing: { project: { work_status: "in-progress", opp_status: "open" }, rev: {}, reason: "" },
  costing: { project: { work_status: "in-progress", opp_status: "open" }, rev: {}, reason: "" },
  submitted: { project: {}, rev: { rev_status: "submitted" }, reason: "" },
};

/** Old revision `status` (new_revision.js) → `rev_status`. */
const LEGACY_REV_STATUS: Record<string, string> = { draft: "draft", ongoing: "draft", costing: "draft", submitted: "submitted" };

/** SAP quote numbers: digits kept as strings, padded to 8 like the old forms. */
function sapList(v: unknown): string[] {
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => String(x).trim()).filter(Boolean).map((x) => (/^\d+$/.test(x) ? x.padStart(8, "0") : x));
}

/** Parse a pasted YAML header (with or without `---` fences). Null when it is not a key/value map. */
export function parseIntake(text: string): Frontmatter | null {
  const body = text.trim().replace(/^---\s*\n/, "").replace(/\n---\s*$/, "");
  if (!body) return null;
  try {
    const v: unknown = parseYaml(body);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Frontmatter) : null;
  } catch {
    return null;
  }
}

/** New project payload: project keys to the PROJECT note, revision keys and `sapq` to Rev-0, old `status` mapped. */
export function projectIntake(parsed: Frontmatter | null): Intake {
  const out: Intake = { project: {}, rev: {}, reason: "" };
  for (const [k, v] of Object.entries(parsed ?? {})) {
    if (v === null || v === undefined || v === "" || OWNED.has(k)) continue;
    if (k === "status") {
      const m = LEGACY_PROJECT_STATUS[String(v)];
      if (m) Object.assign(out.project, m.project), Object.assign(out.rev, m.rev);
    } else if (k === "sapq" || k === "sap") out.rev.sap = sapList(v);
    else if (k === "reason") out.reason = String(v);
    else if (k === "bid_due_date") out.project.bid_due = v;
    else if (REV_KEYS.has(k)) out.rev[k] = v;
    else {
      out.project[k] = v;
      if (k === "pcbr") out.rev.pcbr = v;
    }
  }
  return out;
}

/** New revision payload: every key to the new revision note; `sap_new`, `status`, `reason` from the old form mapped. */
export function revisionIntake(parsed: Frontmatter | null): Intake {
  const out: Intake = { project: {}, rev: {}, reason: "" };
  for (const [k, v] of Object.entries(parsed ?? {})) {
    if (v === null || v === undefined || v === "" || OWNED.has(k)) continue;
    if (k === "sap_new" || k === "sap" || k === "sapq") out.rev.sap = sapList(v);
    else if (k === "status") out.rev.rev_status = LEGACY_REV_STATUS[String(v)] ?? v;
    else if (k === "reason") out.reason = String(v);
    else out.rev[k] = v;
  }
  return out;
}

/** Monospace text area that reports each valid parse; the description shows whether the paste was read. */
function pasteBox(el: HTMLElement, desc: string, sample: string, onParsed: (fm: Frontmatter | null) => void): void {
  const setting = new Setting(el).setName("Paste YAML header (optional)").setDesc(desc);
  setting.settingEl.addClass("rlos-intake-paste");
  setting.addTextArea((t) => {
    t.setPlaceholder(sample);
    t.inputEl.rows = 8;
    t.inputEl.style.width = "100%";
    t.inputEl.style.fontFamily = "var(--font-monospace)";
    t.onChange((v) => {
      const fm = parseIntake(v);
      setting.setDesc(!v.trim() ? desc : fm ? `Read ${Object.keys(fm).length} keys: ${Object.keys(fm).join(", ")}` : "Not valid YAML yet");
      onParsed(fm);
    });
  });
}

export class NewProjectModal extends Modal {
  private kind: KindFolder = "MCCs";
  private opp = "";
  private name = "";
  private pasted: Frontmatter | null = null;

  constructor(
    app: App,
    private readonly submit: (kind: KindFolder, opp: string, name: string, intake: Intake) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("New project");
    let kindSet: (v: KindFolder) => void = () => {};
    let oppText: TextComponent | null = null;
    let nameText: TextComponent | null = null;
    pasteBox(
      this.contentEl,
      "Fills the fields below. Project keys go to the PROJECT note; sapq, sap, rev_status, excel_reference and prices go to Rev-0.",
      "product_type: MCC\nopp: '312892'\nname: Andritz Bucket\nsapq: '25581380'\nend_user: Andritz Inc.\nbid_due: '2026-05-15'\npriority: high",
      (fm) => {
        this.pasted = fm;
        if (!fm) return;
        const pt = String(fm.product_type ?? fm.kind ?? "").toLowerCase();
        if (pt.startsWith("mcc")) kindSet("MCCs");
        else if (pt.startsWith("unit") || pt === "u") kindSet("Units");
        if (fm.opp != null) oppText?.setValue((this.opp = String(fm.opp)));
        if (fm.name != null) nameText?.setValue((this.name = String(fm.name)));
      },
    );
    new Setting(this.contentEl).setName("Kind").addDropdown((d) => {
      kindSet = (v) => d.setValue((this.kind = v));
      d.addOptions({ MCCs: "MCC", Units: "Unit" }).setValue(this.kind).onChange((v) => {
        this.kind = v === "Units" ? "Units" : "MCCs";
      });
    });
    new Setting(this.contentEl).setName("Opportunity number").setDesc("Leave blank for a TEMP project").addText((t) => {
      oppText = t;
      t.onChange((v) => (this.opp = v));
    });
    new Setting(this.contentEl).setName("Name").addText((t) => {
      nameText = t;
      t.onChange((v) => (this.name = v));
    });
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Create").setCta().onClick(() => {
        if (!sanitizeName(this.name)) {
          new Notice("Name is required");
          return;
        }
        this.close();
        void this.submit(this.kind, this.opp, this.name, projectIntake(this.pasted));
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class NewRevisionModal extends Modal {
  private pasted: Frontmatter | null = null;

  constructor(
    app: App,
    private readonly submit: (intake: Intake) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("New revision");
    pasteBox(
      this.contentEl,
      "Keys go to the new revision note; reason becomes its Revision Reason section. Leave blank for a plain revision.",
      "sap_new: '25599412'\npcbr: '5360412'\nexcel_reference: rev1_pricing.xlsx\nreason: |\n  Customer added 3 starter units.",
      (fm) => (this.pasted = fm),
    );
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Create").setCta().onClick(() => {
        this.close();
        void this.submit(revisionIntake(this.pasted));
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
