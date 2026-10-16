import { normalizePath } from "obsidian";

export const PROJECTS_ROOT = "projects";
export const KIND_FOLDERS = ["MCCs", "Units"] as const;
export type KindFolder = (typeof KIND_FOLDERS)[number];
const PRODUCT_TYPE: Record<KindFolder, "MCC" | "Unit"> = { MCCs: "MCC", Units: "Unit" };
export const SCHEMA_PATH = "vault-kit/schemas/projects.schema.json";

export const RFQ = "RFQ";
export const PO = "PO";
const REV_FOLDER = /^Rev-(\d+)$/;

/** Location of a path relative to its project folder. */
export interface ProjectLocation {
  kind: KindFolder;
  /** `<opp> <name>` folder name. */
  folder: string;
  /** Vault path of the project folder. */
  root: string;
  /** First path segment under the project folder (`RFQ`, `Rev-2`, `PO`, a file name), or null for the folder itself. */
  area: string | null;
  /** Rev number when `area` is a `Rev-N` folder. */
  rev: number | null;
}

export function locate(path: string): ProjectLocation | null {
  const parts = normalizePath(path).split("/");
  if (parts[0] !== PROJECTS_ROOT || parts.length < 3) return null;
  const kind = parts[1] as KindFolder;
  if (!KIND_FOLDERS.includes(kind)) return null;
  const folder = parts[2]!;
  const area = parts.length > 3 ? parts[3]! : null;
  const m = area ? REV_FOLDER.exec(area) : null;
  return {
    kind,
    folder,
    root: `${PROJECTS_ROOT}/${kind}/${folder}`,
    area,
    rev: m ? Number(m[1]) : null,
  };
}

export const revFolderName = (n: number) => `Rev-${n}`;
export const parseRevFolder = (name: string): number | null => {
  const m = REV_FOLDER.exec(name);
  return m ? Number(m[1]) : null;
};

const projectNoteName = (folder: string) => `${folder} PROJECT`;
export const revNoteName = (folder: string, n: number) => `${folder} Rev-${n}`;
const canvasName = (folder: string) => `${folder}.canvas`;

export const projectNotePath = (root: string, folder: string) => `${root}/${projectNoteName(folder)}.md`;
export const revNotePath = (root: string, folder: string, n: number) => `${root}/${revFolderName(n)}/${revNoteName(folder, n)}.md`;
export const canvasPath = (root: string, folder: string) => `${root}/${canvasName(folder)}`;

export const wikilink = (basename: string) => `[[${basename}]]`;

/** Note templates (frontmatter placeholders render as YAML scalars). */
export const TEMPLATES = {
  project: "vault-kit/templates/project.md",
  revision: "vault-kit/templates/revision.md",
  po: "vault-kit/templates/po.md",
} as const;

const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;
export function sanitizeName(name: string): string {
  return name.replace(ILLEGAL, " ").replace(/\s+/g, " ").trim();
}

/** Local calendar date as `YYYY-MM-DD` (frontmatter date format). */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Placeholder values shared by the project / revision / PO templates of one project folder. */
export function templateVars(kind: KindFolder, folder: string, opp: string): Record<string, string> {
  return {
    folder,
    opp,
    name: folder.replace(/^\S+\s*/, ""),
    product_type: PRODUCT_TYPE[kind],
    project: projectNoteName(folder),
    project_link: wikilink(projectNoteName(folder)),
    canvas_link: wikilink(canvasName(folder)),
  };
}
