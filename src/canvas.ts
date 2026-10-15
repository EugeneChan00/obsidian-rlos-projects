import { TFile, TFolder, type App } from "obsidian";
import { canvasPath, PO, parseRevFolder, projectNotePath, RFQ, type ProjectLocation } from "./model";

interface CanvasNode {
  id: string;
  type: "file" | "group" | "text" | "link";
  x: number;
  y: number;
  width: number;
  height: number;
  file?: string;
  label?: string;
  /** Advanced Canvas: collapsed group and its stashed contents (positions relative to the group). */
  collapsed?: boolean;
  collapsedData?: { nodes: CanvasNode[]; edges: CanvasEdge[] };
  /** Set when automation collapsed the group, so a user expand is not undone. */
  rlosAutoCollapsed?: boolean;
  [extra: string]: unknown;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: string;
  toSide?: string;
  [extra: string]: unknown;
}

interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [extra: string]: unknown;
}

const PROJECT_NODE = "rlos-project";
const CELL = 360;
const GAP = 40;
const PAD = 40;
const COLS = 4;
const HEADER = 40;
/** Groups are created full grid width so growth is vertical only and never overlaps the next group. */
const GROUP_WIDTH = 2 * PAD + COLS * CELL + (COLS - 1) * GAP;

const groupId = (area: string) => `rlos-group-${area}`;

/** FNV-1a: stable short id for a vault path. */
function pathId(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `rlos-file-${(h >>> 0).toString(16)}`;
}

function overlaps(a: CanvasNode, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inside(n: CanvasNode, g: CanvasNode): boolean {
  return n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height;
}

/** Areas of a project folder in canvas order: RFQ, Rev-N ascending, PO. */
function areasOf(root: TFolder): string[] {
  const names = root.children.filter((c): c is TFolder => c instanceof TFolder).map((c) => c.name);
  const revs = names
    .map((n) => parseRevFolder(n))
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b)
    .map((n) => `Rev-${n}`);
  return [...(names.includes(RFQ) ? [RFQ] : []), ...revs, ...(names.includes(PO) ? [PO] : [])];
}

function filesUnder(folder: TFolder): TFile[] {
  const out: TFile[] = [];
  const walk = (f: TFolder) => {
    for (const c of f.children) {
      if (c instanceof TFile) out.push(c);
      else if (c instanceof TFolder) walk(c);
    }
  };
  walk(folder);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface CanvasSyncOptions {
  /** Rev numbers whose group should be collapsed once (superseded revs). */
  collapseRevs: Set<number>;
}

/**
 * Bring `<folder>.canvas` in line with the project folder. Creates the canvas when absent.
 * Only nodes/edges with the `rlos-` id prefix are added, moved, or removed.
 */
export async function syncProjectCanvas(app: App, loc: ProjectLocation, opts: CanvasSyncOptions): Promise<boolean> {
  const root = app.vault.getAbstractFileByPath(loc.root);
  if (!(root instanceof TFolder)) return false;
  const path = canvasPath(loc.root, loc.folder);
  let file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) file = await app.vault.create(path, JSON.stringify({ nodes: [], edges: [] }, null, "\t"));
  if (!(file instanceof TFile)) return false;

  let changed = false;
  await app.vault.process(file, (raw) => {
    const data = (raw.trim() ? JSON.parse(raw) : {}) as CanvasData;
    data.nodes ??= [];
    data.edges ??= [];
    const before = JSON.stringify(data);
    reconcile(data, loc, root, opts);
    const after = JSON.stringify(data);
    changed = after !== before;
    return changed ? JSON.stringify(data, null, "\t") : raw;
  });
  return changed;
}

function reconcile(data: CanvasData, loc: ProjectLocation, root: TFolder, opts: CanvasSyncOptions): void {
  const projectPath = projectNotePath(loc.root, loc.folder);
  let project = data.nodes.find((n) => n.id === PROJECT_NODE);
  if (!project) {
    project = { id: PROJECT_NODE, type: "file", file: projectPath, x: 0, y: 0, width: 400, height: 520 };
    data.nodes.push(project);
  }
  project.file = projectPath;

  const areas = areasOf(root);
  const groups = new Map<string, CanvasNode>();
  for (const area of areas) groups.set(area, ensureGroup(data, area));

  // Every file path already shown anywhere (including inside collapsed groups).
  const shown = new Set<string>();
  for (const n of data.nodes) {
    if (n.file) shown.add(n.file);
    for (const c of n.collapsedData?.nodes ?? []) if (c.file) shown.add(c.file);
  }

  const desired = new Map<string, string>(); // file path -> area
  for (const area of areas) {
    const folder = root.children.find((c) => c.name === area);
    if (folder instanceof TFolder) for (const f of filesUnder(folder)) desired.set(f.path, area);
  }

  // Drop managed file nodes whose file left its area.
  const keep = (n: CanvasNode) => !(n.id.startsWith("rlos-file-") && (!n.file || !desired.has(n.file)));
  const dropped = new Set(data.nodes.filter((n) => !keep(n)).map((n) => n.id));
  data.nodes = data.nodes.filter(keep);
  for (const g of data.nodes) {
    if (!g.collapsedData) continue;
    for (const n of g.collapsedData.nodes) if (!keep(n)) dropped.add(n.id);
    g.collapsedData.nodes = g.collapsedData.nodes.filter(keep);
    g.collapsedData.edges = g.collapsedData.edges.filter((e) => !dropped.has(e.fromNode) && !dropped.has(e.toNode));
  }
  data.edges = data.edges.filter((e) => !dropped.has(e.fromNode) && !dropped.has(e.toNode));
  for (const f of [...shown]) if (!desired.has(f) && f !== projectPath) shown.delete(f);

  // Add missing files into their group.
  for (const [filePath, area] of desired) {
    if (shown.has(filePath)) continue;
    const group = groups.get(area)!;
    const node: CanvasNode = { id: pathId(filePath), type: "file", file: filePath, x: 0, y: 0, width: CELL, height: CELL };
    if (group.collapsed && group.collapsedData) {
      group.collapsedData.nodes.push({ ...node, ...freeSlot(group.collapsedData.nodes, { ...group, x: 0, y: 0 }) });
    } else {
      const placed = { ...node, ...freeSlot(data.nodes.filter((n) => n.type !== "group"), group) };
      data.nodes.push(placed);
      group.width = Math.max(group.width, placed.x + placed.width + PAD - group.x);
      group.height = Math.max(group.height, placed.y + placed.height + PAD - group.y);
    }
    shown.add(filePath);
  }

  // Remove managed groups whose folder is gone (only when empty of user nodes).
  const areaSet = new Set(areas);
  data.nodes = data.nodes.filter((n) => {
    if (!n.id.startsWith("rlos-group-") || areaSet.has(n.label ?? "")) return true;
    const hasUser = data.nodes.some((m) => m !== n && m.type !== "group" && inside(m, n)) || (n.collapsedData?.nodes.length ?? 0) > 0;
    return hasUser;
  });

  for (const [area, g] of groups) {
    const rev = parseRevFolder(area);
    if (rev !== null && opts.collapseRevs.has(rev) && !g.collapsed && !g.rlosAutoCollapsed) collapse(data, g);
  }

  reconcileEdges(data, areas);
}

function ensureGroup(data: CanvasData, area: string): CanvasNode {
  const id = groupId(area);
  const existing = data.nodes.find((n) => n.id === id);
  if (existing) return existing;
  const right = data.nodes.reduce((max, n) => Math.max(max, n.x + n.width), 0);
  const group: CanvasNode = { id, type: "group", label: area, x: right + 2 * GAP, y: 0, width: GROUP_WIDTH, height: CELL + 2 * PAD + HEADER };
  data.nodes.push(group);
  return group;
}

function freeSlot(members: CanvasNode[], group: CanvasNode): { x: number; y: number } {
  for (let i = 0; ; i++) {
    const rect = {
      x: group.x + PAD + (i % COLS) * (CELL + GAP),
      y: group.y + PAD + HEADER + Math.floor(i / COLS) * (CELL + GAP),
      width: CELL,
      height: CELL,
    };
    if (!members.some((m) => overlaps(m, rect))) return { x: rect.x, y: rect.y };
  }
}

/** Collapse a group in Advanced Canvas's on-disk format. */
function collapse(data: CanvasData, g: CanvasNode): void {
  const members = data.nodes.filter((n) => n.id !== g.id && inside(n, g));
  const ids = new Set(members.map((n) => n.id));
  const edges = data.edges.filter((e) => ids.has(e.fromNode) || ids.has(e.toNode));
  g.collapsed = true;
  g.rlosAutoCollapsed = true;
  g.collapsedData = {
    nodes: [...(g.collapsedData?.nodes ?? []), ...members.map((n) => ({ ...n, x: n.x - g.x, y: n.y - g.y }))],
    edges: [...(g.collapsedData?.edges ?? []), ...edges],
  };
  data.nodes = data.nodes.filter((n) => !ids.has(n.id));
  data.edges = data.edges.filter((e) => !edges.includes(e));
}

function reconcileEdges(data: CanvasData, areas: string[]): void {
  const revs = areas.filter((a) => parseRevFolder(a) !== null);
  const pairs: [string, string][] = [];
  if (areas.includes(RFQ)) pairs.push([PROJECT_NODE, groupId(RFQ)]);
  const chain = [PROJECT_NODE, ...revs.map(groupId), ...(areas.includes(PO) ? [groupId(PO)] : [])];
  for (let i = 1; i < chain.length; i++) pairs.push([chain[i - 1]!, chain[i]!]);

  const want = new Map(pairs.map(([from, to]) => [`rlos-edge-${from}--${to}`, [from, to] as const]));
  data.edges = data.edges.filter((e) => !e.id.startsWith("rlos-edge-") || want.has(e.id));
  const have = new Set(data.edges.map((e) => e.id));
  for (const [id, [from, to]] of want) {
    if (!have.has(id)) data.edges.push({ id, fromNode: from, toNode: to, fromSide: "right", toSide: "left" });
  }
}
