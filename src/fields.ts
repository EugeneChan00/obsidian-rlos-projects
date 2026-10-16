import type { App } from "obsidian";
import type { AutomationApi, Frontmatter } from "vault-automation/src/api";
import { PO, PROJECTS_ROOT, parseRevFolder, projectNotePath, revNotePath, today, type ProjectLocation } from "./model";

export type NoteKind = "project" | "revision" | "po";
export const NOTE_KINDS: readonly NoteKind[] = ["project", "revision", "po"];

/** A `{token}` bound to a frontmatter property on one of the project's notes. */
export interface FieldBinding {
  token: string;
  note: NoteKind;
  /** Exact frontmatter key (YAML keys are case-sensitive). */
  property: string;
  /** Keep digits only (opportunity, SAP quote, sales order numbers). */
  digits: boolean;
  /** When empty: a project property or built-in token offered as a value to confirm. "" = none. */
  prefill: string;
}

export const DEFAULT_FIELDS: FieldBinding[] = [
  { token: "opp", note: "project", property: "opp", digits: true, prefill: "folder_opp" },
  { token: "name", note: "project", property: "name", digits: false, prefill: "" },
  // Each rev can have its own SAP quote; the project-level `sapq` may belong to another rev, so it is only a prefill.
  { token: "sapq", note: "revision", property: "sap", digits: true, prefill: "sapq" },
  { token: "pcbr", note: "project", property: "pcbr", digits: true, prefill: "" },
  { token: "po_number", note: "po", property: "po_number", digits: false, prefill: "" },
  { token: "sales_order", note: "po", property: "sales_order", digits: true, prefill: "" },
  { token: "end_user", note: "project", property: "end_user", digits: false, prefill: "" },
  { token: "site", note: "project", property: "site", digits: false, prefill: "" },
];

export const BUILTIN_TOKENS: Record<string, string> = {
  folder: "project folder name (<opp> <name>)",
  folder_opp: "digits at the start of the folder name (empty for TEMP- projects)",
  rev: "rev number: the Rev-N you are in, else current_rev",
  date: "today, YYYY-MM-DD",
  yymmdd: "today, YYMMDD",
};

const TOKEN_NAME = /^[a-z][a-z0-9_]*$/;

export function isFieldBinding(v: unknown): v is FieldBinding {
  if (!v || typeof v !== "object") return false;
  const note: unknown = Reflect.get(v, "note");
  return (
    ["token", "property", "prefill"].every((k) => typeof Reflect.get(v, k) === "string") &&
    typeof Reflect.get(v, "digits") === "boolean" &&
    typeof note === "string" &&
    (NOTE_KINDS as readonly string[]).includes(note)
  );
}

// ---------------------------------------------------------------------------------------------
// Property index: exact frontmatter keys per note kind, plus Obsidian's property registry.

export interface PropertyIndex {
  /** Exact key → number of notes of that kind carrying it. */
  keys: Record<NoteKind, Map<string, number>>;
  /** Obsidian's property registry (case-insensitive): lowercase → display name and widget. */
  registry: Map<string, { name: string; widget: string }>;
  /** Properties with a type assigned in `.obsidian/types.json`, exact case. */
  assigned: Set<string>;
}

interface TypeManager {
  getAllProperties(): Record<string, { name: string; widget?: string; type?: string }>;
  setType(name: string, widget: string): void;
}

function typeManager(app: App): TypeManager | null {
  const m: unknown = Reflect.get(app, "metadataTypeManager");
  if (!m || typeof m !== "object") return null;
  if (typeof Reflect.get(m, "getAllProperties") !== "function" || typeof Reflect.get(m, "setType") !== "function") return null;
  // Undocumented but stable since Obsidian 1.4; narrowed by the method checks above.
  return m as TypeManager;
}

function assignedTypes(app: App): Set<string> {
  const m: unknown = Reflect.get(app, "metadataTypeManager");
  const types: unknown = m && typeof m === "object" ? Reflect.get(m, "types") : null;
  return new Set(types && typeof types === "object" ? Object.keys(types) : []);
}

export function buildPropertyIndex(app: App, api: AutomationApi): PropertyIndex {
  const keys: Record<NoteKind, Map<string, number>> = { project: new Map(), revision: new Map(), po: new Map() };
  for (const file of api.notes.list(PROJECTS_ROOT, { recursive: true })) {
    if (file.extension !== "md") continue;
    const fm = api.props.get(file.path);
    const kind = fm?.type;
    if (kind !== "project" && kind !== "revision" && kind !== "po") continue;
    for (const k of Object.keys(fm!)) keys[kind].set(k, (keys[kind].get(k) ?? 0) + 1);
  }
  const registry = new Map<string, { name: string; widget: string }>();
  const all = typeManager(app)?.getAllProperties() ?? {};
  for (const [lower, info] of Object.entries(all)) registry.set(lower.toLowerCase(), { name: info.name, widget: info.widget ?? info.type ?? "text" });
  return { keys, registry, assigned: assignedTypes(app) };
}

// ---------------------------------------------------------------------------------------------
// Validation (configuration side).

export interface Issue {
  level: "error" | "warning";
  /** Row the issue belongs to: `field:<index>` or `template:<index>`. */
  where: string;
  message: string;
  /** Corrected binding offered by a fix button. */
  fix?: { label: string; binding: FieldBinding };
}

function caseCheck(where: string, binding: FieldBinding, key: "property" | "prefill", kind: NoteKind, index: PropertyIndex, out: Issue[]): void {
  const name = binding[key];
  const label = key === "property" ? "Property" : "Prefill property";
  if (name !== name.trim()) {
    out.push({ level: "error", where, message: `${label} \`${name}\` has leading or trailing spaces.`, fix: { label: "Trim", binding: { ...binding, [key]: name.trim() } } });
    return;
  }
  const used = index.keys[kind];
  if (used.has(name)) {
    const reg = index.registry.get(name.toLowerCase());
    if (reg && reg.name !== name)
      out.push({
        level: "warning",
        where,
        message: `${label} \`${name}\`: Obsidian lists it as \`${reg.name}\` (the first spelling it met, from an untyped legacy note); ${kind} notes use \`${name}\` (${used.get(name)}). The binding follows the notes; saving the settings registers \`${name}\` with Obsidian.`,
      });
    return;
  }
  const sameIgnoringCase = [...used.entries()].filter(([k]) => k.toLowerCase() === name.toLowerCase()).sort((a, b) => b[1] - a[1]);
  if (sameIgnoringCase.length) {
    const [exact, count] = sameIgnoringCase[0]!;
    out.push({
      level: "error",
      where,
      message: `${label} \`${name}\` does not match case: ${kind} notes use \`${exact}\` (${count} notes). Frontmatter keys are case-sensitive.`,
      fix: { label: `Use ${exact}`, binding: { ...binding, [key]: exact } },
    });
    return;
  }
  const reg = index.registry.get(name.toLowerCase());
  if (reg && reg.name !== name)
    out.push({
      level: "error",
      where,
      message: `${label} \`${name}\` does not match Obsidian's property \`${reg.name}\`, and no ${kind} note uses either spelling.`,
      fix: { label: `Use ${reg.name}`, binding: { ...binding, [key]: reg.name } },
    });
  else
    out.push({
      level: "warning",
      where,
      message: `No ${kind} note has \`${name}\` yet${key === "property" ? "; it is created when you type a value (if saving back is on)" : ""}.`,
    });
}

export function validateFields(fields: FieldBinding[], index: PropertyIndex): Issue[] {
  const out: Issue[] = [];
  const seen = new Map<string, number>();
  fields.forEach((f, i) => {
    const where = `field:${i}`;
    if (!TOKEN_NAME.test(f.token)) out.push({ level: "error", where, message: `Token \`${f.token}\` must be lowercase letters, digits and _ and start with a letter.` });
    else if (f.token in BUILTIN_TOKENS) out.push({ level: "error", where, message: `Token \`{${f.token}}\` is built in; pick another name.` });
    else if (seen.has(f.token)) out.push({ level: "error", where, message: `Token \`{${f.token}}\` is already defined in row ${seen.get(f.token)! + 1}.` });
    else seen.set(f.token, i);
    if (!f.property.trim()) out.push({ level: "error", where, message: "Property is required." });
    else caseCheck(where, f, "property", f.note, index, out);
    if (f.prefill && !(f.prefill in BUILTIN_TOKENS)) caseCheck(where, f, "prefill", "project", index, out);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Resolution and save-back.

export interface TokenValue {
  value: string;
  /** Suggested value to confirm when `value` is empty or ambiguous. */
  suggestion: string;
  /** Why the value must be asked for; empty when `value` is usable as is. */
  ask: string;
}

export interface FieldContext {
  loc: ProjectLocation;
  rev: number | null;
  /** Note path per kind, null when the note does not exist (e.g. no PO yet). */
  notes: Record<NoteKind, string | null>;
  values: Record<string, TokenValue>;
}

const clean = (v: unknown, digits: boolean): string => {
  const s = typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
  return digits ? s.replace(/\D/g, "") : s;
};

export function resolveFields(api: AutomationApi, loc: ProjectLocation, fields: FieldBinding[]): FieldContext {
  const projectPath = projectNotePath(loc.root, loc.folder);
  const project: Frontmatter = api.props.get(projectPath) ?? {};
  const currentRev = /Rev-(\d+)\]\]$/.exec(typeof project.current_rev === "string" ? project.current_rev : "");
  const revs = api.notes.subfolders(loc.root).map(parseRevFolder).filter((n): n is number => n !== null);
  const rev = loc.rev ?? (currentRev ? Number(currentRev[1]) : revs.length ? Math.max(...revs) : null);
  const revPath = rev === null ? null : revNotePath(loc.root, loc.folder, rev);
  const poPath =
    api.notes
      .list(`${loc.root}/${PO}`, { recursive: true })
      .find((f) => f.extension === "md" && api.props.get(f.path)?.type === "po")?.path ?? null;
  const notes: Record<NoteKind, string | null> = {
    project: api.notes.file(projectPath) ? projectPath : null,
    revision: revPath && api.notes.file(revPath) ? revPath : null,
    po: poPath,
  };
  const date = today();
  const builtins: Record<string, string> = {
    folder: loc.folder,
    folder_opp: /^\d+/.exec(loc.folder)?.[0] ?? "",
    rev: rev === null ? "" : String(rev),
    date,
    yymmdd: date.slice(2).replace(/-/g, ""),
  };
  const values: Record<string, TokenValue> = {};
  for (const [k, v] of Object.entries(builtins)) values[k] = { value: v, suggestion: "", ask: v ? "" : `no ${k}` };
  for (const f of fields) {
    const path = notes[f.note];
    const fm: Frontmatter = path ? (api.props.get(path) ?? {}) : {};
    const raw = fm[f.property];
    const suggestion = f.prefill ? (f.prefill in builtins ? clean(builtins[f.prefill], f.digits) : clean(project[f.prefill], f.digits)) : "";
    if (Array.isArray(raw)) {
      const items = [...new Set(raw.map((x) => clean(x, f.digits)).filter(Boolean))];
      if (items.length === 1) values[f.token] = { value: items[0]!, suggestion: "", ask: "" };
      else if (items.length > 1) values[f.token] = { value: "", suggestion: items[items.length - 1]!, ask: `${items.length} values in ${f.note} \`${f.property}\`: ${items.join(", ")}` };
      else values[f.token] = { value: "", suggestion, ask: path ? `${f.note} \`${f.property}\` is empty` : `no ${f.note} note` };
      continue;
    }
    const value = clean(raw, f.digits);
    values[f.token] = { value, suggestion: value ? "" : suggestion, ask: value ? "" : path ? `${f.note} \`${f.property}\` is empty` : `no ${f.note} note` };
  }
  return { loc, rev, notes, values };
}

/** Write typed values to their bound properties. Returns what was written and what could not be. */
export async function saveBack(
  app: App,
  api: AutomationApi,
  ctx: FieldContext,
  fields: FieldBinding[],
  typed: Record<string, string>,
): Promise<{ saved: string[]; skipped: string[] }> {
  const saved: string[] = [];
  const skipped: string[] = [];
  const registry = typeManager(app)?.getAllProperties() ?? {};
  for (const [token, value] of Object.entries(typed)) {
    const f = fields.find((x) => x.token === token);
    if (!f) continue;
    const path = ctx.notes[f.note];
    if (!path) {
      skipped.push(`{${token}}: no ${f.note} note`);
      continue;
    }
    const widget = registry[f.property.toLowerCase()]?.widget ?? "text";
    await api.props.set(path, (fm) => {
      const current = fm[f.property];
      if (Array.isArray(current) || widget === "multitext") {
        const list = Array.isArray(current) ? current : current === undefined || current === null || current === "" ? [] : [current];
        const numeric = list.length > 0 && list.every((x) => typeof x === "number");
        if (!list.map((x) => clean(x, f.digits)).includes(value)) list.push(numeric && /^\d+$/.test(value) ? Number(value) : value);
        fm[f.property] = list;
      } else fm[f.property] = typeof current === "number" && /^\d+$/.test(value) ? Number(value) : value;
    });
    saved.push(`${f.property} on ${path.split("/").pop()!.replace(/\.md$/, "")}`);
  }
  return { saved, skipped };
}

/** Give bound (and prefill) properties without a type a type in Obsidian, spelled exactly as bound. */
export function registerPropertyTypes(app: App, fields: FieldBinding[], index: PropertyIndex): string[] {
  const tm = typeManager(app);
  if (!tm) return [];
  const names = new Set(fields.flatMap((f) => [f.property, ...(f.prefill && !(f.prefill in BUILTIN_TOKENS) ? [f.prefill] : [])]));
  const added: string[] = [];
  for (const name of names) {
    if ([...index.assigned].some((k) => k.toLowerCase() === name.toLowerCase())) continue;
    tm.setType(name, index.registry.get(name.toLowerCase())?.widget ?? "text");
    index.assigned.add(name);
    added.push(name);
  }
  return added;
}
