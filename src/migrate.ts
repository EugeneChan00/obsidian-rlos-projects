import { TFile, TFolder, type App, type TAbstractFile } from "obsidian";
import { renderTemplate } from "./automation";
import {
  canvasName,
  KIND_FOLDERS,
  PO,
  poNotePath,
  PRODUCT_TYPE,
  projectNoteName,
  projectNotePath,
  PROJECTS_ROOT,
  revFolderName,
  revNoteName,
  revNotePath,
  RFQ,
  sanitizeName,
  templateVars,
  wikilink,
  type KindFolder,
} from "./model";

type Fm = Record<string, unknown>;

export const PLAN_PATH = "MIGRATION-PLAN.md";
export const REPORT_PATH = "MIGRATION-REPORT.md";

/** Old project `status` → [work_status, opp_status]. */
const STATUS_MAP: Record<string, [string, string]> = {
  intake: ["backlog", "open"],
  todo: ["todo", "open"],
  ongoing: ["in-progress", "open"],
  costing: ["in-progress", "open"],
  active: ["in-progress", "open"],
  quoting: ["in-progress", "open"],
  submitted: ["done", "submitted"],
  ordering: ["in-progress", "post-sales"],
  shipped: ["in-progress", "post-sales"],
  won: ["done", "won"],
  lost: ["done", "lost"],
  disqualified: ["done", "lost"],
  cancelled: ["done", "lost"],
};
const OLD_REV_ACCEPTED: Record<string, true> = { won: true, ordered: true, ordering: true };
const PO_DIRS: Record<string, true> = { po: true, "po-entry": true, wpmccpo: true, kom: true };
const RFQ_EXT: Record<string, true> = {
  pdf: true, xlsx: true, xlsm: true, xls: true, docx: true, doc: true, png: true, jpg: true, jpeg: true, webp: true,
  eml: true, msg: true, zip: true, txt: true, csv: true, dwg: true,
};
const OLD_REV = /^(WPMCC|WPU)(\d+)$/;
const OLD_REV_NOTE = /^(mcc|u)_rev_\d+\.md$/;
const SKIP_FOLDERS: Record<string, true> = { mcc_template: true };

export interface RevPlan {
  from: string;
  n: number;
  /** Existing note that becomes the rev note, or null to create one. */
  note: string | null;
  oldStatus: string;
  revStatus: string;
}

export interface ProjectPlan {
  kind: KindFolder;
  oldRoot: string;
  folder: string;
  newRoot: string;
  projectNote: string | null;
  opp: string;
  oldStatus: string;
  workStatus: string;
  oppStatus: string;
  revs: RevPlan[];
  poDirs: string[];
  toRfq: string[];
  createPo: boolean;
  acceptedRev: number | null;
  issues: string[];
}

export interface MigrationPlan {
  projects: ProjectPlan[];
  /** Paths left in place for a human decision. */
  unresolved: { path: string; reason: string }[];
}

const fmOf = (app: App, path: string | null): Fm => {
  const f = path ? app.vault.getAbstractFileByPath(path) : null;
  return (f instanceof TFile ? app.metadataCache.getFileCache(f)?.frontmatter : undefined) ?? {};
};

function lastStatus(v: unknown): string {
  const raw = Array.isArray(v) ? v[v.length - 1] : v;
  return String(raw ?? "").trim().toLowerCase();
}

function deriveFolder(name: string, fm: Fm, project: TFile | null): { opp: string; folder: string } {
  const fmOpp = /^D{0,2}(\d{5,})$/i.exec(String(fm.opp ?? "").trim())?.[1] ?? "";
  const m = /^D{0,2}(\d{5,})\b/.exec(name);
  const opp = fmOpp || (m?.[1] ?? "");
  const label = sanitizeName(
    name
      .replace(/^D{0,2}\d{5,}\s*/, "")
      .replace(/^Dtemp\s*/i, "")
      .replace(/\bSAPQ\d+\s*/g, "")
      .replace(/\bD?temp\b\s*/gi, ""),
  ) || sanitizeName(String(fm.name ?? "")) || name;
  if (opp) return { opp, folder: `${opp} ${label}` };
  const received = typeof fm.received_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(fm.received_date) ? new Date(fm.received_date) : null;
  const d = received ?? new Date(project?.stat.ctime ?? Date.now());
  const yymmdd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return { opp: "", folder: `TEMP-${yymmdd} ${label}` };
}

export function buildPlan(app: App): MigrationPlan {
  const plan: MigrationPlan = { projects: [], unresolved: [] };
  const taken = new Map<string, string>();
  for (const kind of KIND_FOLDERS) {
    const kindFolder = app.vault.getAbstractFileByPath(`${PROJECTS_ROOT}/${kind}`);
    if (!(kindFolder instanceof TFolder)) continue;
    for (const child of [...kindFolder.children].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!(child instanceof TFolder)) {
        plan.unresolved.push({ path: child.path, reason: "loose file in kind folder" });
        continue;
      }
      if (SKIP_FOLDERS[child.name]) {
        plan.unresolved.push({ path: child.path, reason: "old template folder; superseded by policy/templates" });
        continue;
      }
      if (child.children.some((c) => c.name === `${projectNoteName(child.name)}.md`)) continue; // already in the new layout
      const p = planProject(app, kind, child, plan);
      const key = p.newRoot.toLowerCase();
      const clash = taken.get(key);
      if (clash) {
        p.issues.push(`target folder collides with ${clash}; kept old folder name`);
        p.folder = child.name;
        p.newRoot = child.path;
      }
      taken.set(p.newRoot.toLowerCase(), child.path);
      plan.projects.push(p);
    }
  }
  return plan;
}

function planProject(app: App, kind: KindFolder, root: TFolder, plan: MigrationPlan): ProjectPlan {
  const projectFile = root.children.find((c): c is TFile => c instanceof TFile && c.name === "project.md") ?? null;
  const fm = fmOf(app, projectFile?.path ?? null);
  const { opp, folder } = deriveFolder(root.name, fm, projectFile);
  const oldStatus = lastStatus(fm.status);
  const issues: string[] = [];
  const mapped = STATUS_MAP[oldStatus];
  if (!mapped) issues.push(`status ${JSON.stringify(fm.status ?? null)} unmapped → backlog/open`);
  let [workStatus, oppStatus] = mapped ?? ["backlog", "open"];

  const revs: RevPlan[] = [];
  const poDirs: string[] = [];
  const toRfq: string[] = [];
  const seenRev = new Set<number>();
  for (const c of [...root.children].sort((a, b) => a.name.localeCompare(b.name))) {
    if (c instanceof TFolder) {
      const m = OLD_REV.exec(c.name);
      if (m) {
        const n = Number(m[2]);
        if (seenRev.has(n)) {
          plan.unresolved.push({ path: c.path, reason: `duplicate rev ${n}` });
          continue;
        }
        seenRev.add(n);
        const mds = c.children.filter((f): f is TFile => f instanceof TFile && f.extension === "md");
        const note = mds.find((f) => OLD_REV_NOTE.test(f.name)) ?? (mds.length === 1 ? mds[0] : mds.find((f) => f.name === "notes.md")) ?? null;
        revs.push({ from: c.path, n, note: note?.path ?? null, oldStatus: lastStatus(fmOf(app, note?.path ?? null).status), revStatus: "draft" });
      } else if (c.name === RFQ) {
        // stays
      } else if (c.name === PO || PO_DIRS[c.name.toLowerCase()]) {
        poDirs.push(c.path);
      } else {
        plan.unresolved.push({ path: c.path, reason: "non-standard folder at project root" });
      }
    } else if (c instanceof TFile) {
      if (c === projectFile) continue;
      if (RFQ_EXT[c.extension.toLowerCase()]) toRfq.push(c.path);
      else plan.unresolved.push({ path: c.path, reason: "non-standard file at project root" });
    }
  }
  revs.sort((a, b) => a.n - b.n);

  // Rev status: explicit old values first, then derive from the project outcome.
  for (const r of revs) {
    if (r.oldStatus === "submitted") r.revStatus = "submitted";
    if (OLD_REV_ACCEPTED[r.oldStatus]) r.revStatus = "accepted";
  }
  const latest = revs[revs.length - 1];
  // Rev `order_value` held the quoted total, not an order; only a PO number/date or PO folder is order evidence.
  const hasPoData = (f: Fm) => Boolean(f.po_number) || Boolean(f.order_date);
  const poEvidence = poDirs.length > 0 || hasPoData(fm) || Number(fm.total_value) > 0 || revs.some((r) => hasPoData(fmOf(app, r.note)));
  let accepted = revs.find((r) => r.revStatus === "accepted") ?? revs.find((r) => hasPoData(fmOf(app, r.note))) ?? null;
  if (latest && oppStatus !== "open" && latest.revStatus === "draft") latest.revStatus = "submitted";
  if ((poEvidence || oppStatus === "post-sales" || oppStatus === "won") && !accepted && latest) accepted = latest;
  if (accepted) accepted.revStatus = "accepted";
  for (const r of revs) if (r !== latest && r !== accepted && r.revStatus !== "accepted") r.revStatus = "superseded";
  if (accepted && oppStatus !== "post-sales" && oppStatus !== "won" && oppStatus !== "lost") {
    issues.push(`PO evidence on ${accepted.from.split("/").pop()}; opp_status ${oppStatus} → post-sales`);
    oppStatus = "post-sales";
    if (workStatus === "done" || workStatus === "backlog") workStatus = "in-progress";
  }

  const createPo = poEvidence || accepted !== null;
  const newRoot = `${PROJECTS_ROOT}/${kind}/${folder}`;
  if (!projectFile) issues.push("no project.md; one will be created");
  return {
    kind, oldRoot: root.path, folder, newRoot, projectNote: projectFile?.path ?? null, opp, oldStatus, workStatus, oppStatus,
    revs, poDirs, toRfq, createPo, acceptedRev: accepted?.n ?? null, issues,
  };
}

export function renderPlan(plan: MigrationPlan, title: string): string {
  const moved = plan.projects.filter((p) => p.newRoot !== p.oldRoot).length;
  const revCount = plan.projects.reduce((n, p) => n + p.revs.length, 0);
  const lines = [
    "---",
    "type: migration-plan",
    "---",
    "",
    `# ${title}`,
    "",
    "Spec: [[policy/PROJECTS]]. Run **RLOS: Apply project layout migration** after review.",
    "",
    "| Metric | Count |",
    "| --- | --- |",
    `| Projects | ${plan.projects.length} |`,
    `| Folders renamed | ${moved} |`,
    `| Revisions | ${revCount} |`,
    `| Rev notes created | ${plan.projects.reduce((n, p) => n + p.revs.filter((r) => !r.note).length, 0)} |`,
    `| PO notes created | ${plan.projects.filter((p) => p.createPo).length} |`,
    `| Root files → RFQ/ | ${plan.projects.reduce((n, p) => n + p.toRfq.length, 0)} |`,
    `| Projects with issues | ${plan.projects.filter((p) => p.issues.length).length} |`,
    `| Unresolved paths (left in place) | ${plan.unresolved.length} |`,
    "",
    "## Status mapping",
    "",
    "| Old status | work_status | opp_status | Projects |",
    "| --- | --- | --- | --- |",
  ];
  const counts = new Map<string, number>();
  for (const p of plan.projects) {
    const k = `${p.oldStatus || "(empty)"}|${p.workStatus}|${p.oppStatus}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) lines.push(`| ${k.split("|").join(" | ")} | ${n} |`);
  lines.push("", "## Unresolved (left in place)", "", "| Path | Reason |", "| --- | --- |");
  for (const u of plan.unresolved) lines.push(`| \`${u.path}\` | ${u.reason} |`);
  lines.push("", "## Projects", "", "| Kind | Old folder | New folder | work / opp | Revs (old → rev_status) | PO | RFQ+ | Issues |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of plan.projects) {
    const old = p.oldRoot.split("/").pop()!;
    const revs = p.revs.map((r) => `${r.from.split("/").pop()}→Rev-${r.n}:${r.revStatus}${r.note ? "" : "(new)"}`).join("<br>");
    lines.push(
      `| ${p.kind} | ${old} | ${p.folder === old ? "=" : p.folder} | ${p.workStatus} / ${p.oppStatus} | ${revs} | ${p.createPo ? `Rev-${p.acceptedRev ?? "?"}` : ""} | ${p.toRfq.length || ""} | ${p.issues.join("; ")} |`,
    );
  }
  return lines.join("\n") + "\n";
}

/** Rename via an intermediate name when only case differs (case-insensitive filesystems). */
async function moveTo(app: App, file: TAbstractFile, target: string): Promise<void> {
  if (file.path === target) return;
  if (file.path.toLowerCase() === target.toLowerCase()) await app.fileManager.renameFile(file, `${target}.rlos-tmp`);
  await app.fileManager.renameFile(file, target);
}

async function ensureFolder(app: App, path: string): Promise<TFolder> {
  const f = app.vault.getAbstractFileByPath(path);
  if (f instanceof TFolder) return f;
  return app.vault.createFolder(path);
}

function freePath(app: App, dir: string, name: string): string {
  let target = `${dir}/${name}`;
  const dot = name.lastIndexOf(".");
  for (let i = 2; app.vault.getAbstractFileByPath(target); i++) {
    target = dot > 0 ? `${dir}/${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${dir}/${name} (${i})`;
  }
  return target;
}

export async function applyPlan(app: App, plan: MigrationPlan, log: (line: string) => void): Promise<void> {
  for (const p of plan.projects) {
    try {
      await applyProject(app, p);
      log(`ok   ${p.newRoot}`);
    } catch (e) {
      log(`FAIL ${p.oldRoot}: ${(e as Error).message}`);
    }
  }
}

async function applyProject(app: App, p: ProjectPlan): Promise<void> {
  const root = app.vault.getAbstractFileByPath(p.oldRoot);
  if (!(root instanceof TFolder)) throw new Error("project folder missing");
  await moveTo(app, root, p.newRoot);
  const at = (old: string) => p.newRoot + old.slice(p.oldRoot.length);

  // Revisions: folder, then note.
  for (const r of p.revs) {
    const folder = app.vault.getAbstractFileByPath(at(r.from));
    if (!(folder instanceof TFolder)) throw new Error(`rev folder missing: ${r.from}`);
    await moveTo(app, folder, `${p.newRoot}/${revFolderName(r.n)}`);
    if (r.note) {
      const note = app.vault.getAbstractFileByPath(`${p.newRoot}/${revFolderName(r.n)}/${r.note.split("/").pop()}`);
      if (note instanceof TFile) await moveTo(app, note, revNotePath(p.newRoot, p.folder, r.n));
    }
  }

  // Project note.
  const projectPath = projectNotePath(p.newRoot, p.folder);
  if (p.projectNote) {
    const f = app.vault.getAbstractFileByPath(at(p.projectNote));
    if (f instanceof TFile) await moveTo(app, f, projectPath);
  } else {
    await renderTemplate(app, "project", projectPath, templateVars(p.kind, p.folder, p.opp));
  }

  // PO folders → PO/.
  for (const dir of p.poDirs) {
    const f = app.vault.getAbstractFileByPath(at(dir));
    if (!(f instanceof TFolder) || f.path === `${p.newRoot}/${PO}`) continue;
    if (!app.vault.getAbstractFileByPath(`${p.newRoot}/${PO}`) && f.path.toLowerCase() !== `${p.newRoot}/${PO}`.toLowerCase()) {
      await moveTo(app, f, `${p.newRoot}/${PO}`);
      continue;
    }
    if (f.path.toLowerCase() === `${p.newRoot}/${PO}`.toLowerCase()) {
      await moveTo(app, f, `${p.newRoot}/${PO}`);
      continue;
    }
    const target = await ensureFolder(app, `${p.newRoot}/${PO}`);
    for (const c of [...f.children]) await moveTo(app, c, freePath(app, target.path, c.name));
    if (f.children.length === 0) await app.vault.delete(f, true);
  }

  // Root files → RFQ/.
  if (p.toRfq.length) {
    const rfq = await ensureFolder(app, `${p.newRoot}/${RFQ}`);
    for (const old of p.toRfq) {
      const f = app.vault.getAbstractFileByPath(at(old));
      if (f instanceof TFile) await moveTo(app, f, freePath(app, rfq.path, f.name));
    }
  }

  // Revision rev notes + frontmatter.
  const poFields: Fm = {};
  for (const r of p.revs) {
    const path = revNotePath(p.newRoot, p.folder, r.n);
    let note = app.vault.getAbstractFileByPath(path);
    if (!(note instanceof TFile)) {
      note = await renderTemplate(app, "revision", path, { ...templateVars(p.kind, p.folder, p.opp), rev: r.n });
    }
    await app.fileManager.processFrontMatter(note as TFile, (f: Fm) => {
      if (Number(f.order_value) > 0 && !(Number(f.sell_price) > 0)) f.sell_price = f.order_value;
      if (f.po_number) poFields.po_number = String(f.po_number);
      if (f.order_date) poFields.order_date = String(f.order_date);
      for (const k of ["status", "metadata_rev", "po_number", "order_date", "order_value"]) delete f[k];
      f.type = "revision";
      f.uuid ||= crypto.randomUUID();
      f.opp = p.opp;
      f.product_type = PRODUCT_TYPE[p.kind];
      f.project = wikilink(projectNoteName(p.folder));
      f.rev = r.n;
      f.rev_status = r.revStatus;
    });
    await fixProjectLinks(app, note as TFile, projectNoteName(p.folder));
  }

  const project = app.vault.getAbstractFileByPath(projectPath);
  if (!(project instanceof TFile)) throw new Error("project note missing after move");
  const latest = p.revs[p.revs.length - 1];
  await app.fileManager.processFrontMatter(project, (f: Fm) => {
    if (f.po_number) poFields.po_number = String(f.po_number);
    if (f.order_date) poFields.order_date = String(f.order_date);
    if (Number(f.total_value) > 0) poFields.order_value = f.total_value;
    for (const k of ["status", "po_number", "order_date", "total_value"]) delete f[k];
    if (Array.isArray(f.tags)) f.tags = f.tags.filter((t) => !String(t).startsWith("Status/"));
    f.type = "project";
    f.uuid ||= crypto.randomUUID();
    f.opp = p.opp;
    f.product_type = PRODUCT_TYPE[p.kind];
    const aliases = Array.isArray(f.aliases) ? f.aliases.map(String) : [];
    if (!aliases.includes(p.folder)) aliases.push(p.folder);
    f.aliases = aliases;
    f.work_status = p.workStatus;
    f.opp_status = p.oppStatus;
    if (latest) f.current_rev = wikilink(revNoteName(p.folder, latest.n));
    f.canvas = wikilink(canvasName(p.folder));
  });

  if (p.createPo) {
    const path = poNotePath(p.newRoot, p.folder);
    let po = app.vault.getAbstractFileByPath(path);
    if (!(po instanceof TFile)) {
      await ensureFolder(app, `${p.newRoot}/${PO}`);
      po = await renderTemplate(app, "po", path, templateVars(p.kind, p.folder, p.opp));
    }
    await app.fileManager.processFrontMatter(po as TFile, (f: Fm) => {
      Object.assign(f, poFields);
      if (p.acceptedRev !== null) f.accepted_rev = wikilink(revNoteName(p.folder, p.acceptedRev));
    });
  }
}

/** Old rev bodies link the project as `[[../../project]]` or `[[policy/templates/project|…]]`. */
async function fixProjectLinks(app: App, note: TFile, projectName: string): Promise<void> {
  await app.vault.process(note, (body) =>
    body.replace(/\[\[([^\]|#]*\/)?project(\.md)?(\|[^\]]*)?\]\]/g, (_m, _dir, _ext, alias: string | undefined) => `[[${projectName}${alias ?? "|Project Hub"}]]`),
  );
}
