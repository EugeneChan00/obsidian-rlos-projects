import { Notice, SuggestModal, type App } from "obsidian";
import type { AutomationApi, Validator } from "vault-automation/src/api";
import type { FieldContext } from "./fields";

interface StatusChoice {
  path: string;
  note: string;
  field: string;
  value: string;
  current: boolean;
}

/** Status fields per note, with the schema `$defs` entry that lists their values. */
const STATUS_FIELDS: { note: "project" | "revision"; field: string; def: string }[] = [
  { note: "project", field: "work_status", def: "workStatus" },
  { note: "project", field: "opp_status", def: "oppStatus" },
  { note: "revision", field: "rev_status", def: "revStatus" },
];

/** Set work_status / opp_status on the project or rev_status on the rev; status automation reacts as usual. */
export class ChangeStatusModal extends SuggestModal<StatusChoice> {
  private readonly choices: StatusChoice[] = [];

  constructor(
    app: App,
    private readonly api: AutomationApi,
    ctx: FieldContext,
    schema: Validator,
  ) {
    super(app);
    for (const s of STATUS_FIELDS) {
      const path = ctx.notes[s.note];
      if (!path) continue;
      const current = String(api.props.get(path)?.[s.field] ?? "");
      const note = s.note === "project" ? "Project" : `Rev-${ctx.rev}`;
      for (const value of schema.enumOf(s.def).map(String).filter(Boolean)) this.choices.push({ path, note, field: s.field, value, current: value === current });
    }
    this.setPlaceholder(`Change status — ${ctx.loc.folder}${ctx.rev === null ? "" : ` · Rev-${ctx.rev}`}`);
  }

  getSuggestions(query: string): StatusChoice[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.choices.filter((c) => words.every((w) => `${c.note} ${c.field} ${c.value}`.toLowerCase().includes(w)));
  }

  renderSuggestion(c: StatusChoice, el: HTMLElement): void {
    el.createDiv({ text: `${c.field} → ${c.value}${c.current ? "  (current)" : ""}` });
    el.createEl("small", { text: c.note });
  }

  onChooseSuggestion(c: StatusChoice): void {
    if (c.current) return;
    void this.api.props.set(c.path, { [c.field]: c.value }).then(() => new Notice(`${c.note}: ${c.field} → ${c.value}`));
  }
}
