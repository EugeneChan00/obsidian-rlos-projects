import { TFile, type App } from "obsidian";
import { canvasPath, locate } from "./model";

/** Public API exposed by the rlos fork of Window Spaces as `app.plugins.plugins["window-spaces"].api`. */
export interface WindowSpacesApi {
  findSpaceByName(name: string): { id: string; name: string; sections?: string[]; archived?: boolean } | undefined;
  /** Create a saved space (no window opened) whose single tab shows `file`. Returns the space id. */
  ensureSpaceForFile(file: TFile, opts: { name: string; section: string }): Promise<string>;
  setSection(spaceId: string, section: string): Promise<void>;
  setArchived(spaceId: string, archived: boolean): Promise<void>;
}

const LIVE_OPP: Record<string, true> = { open: true, submitted: true, revising: true, "post-sales": true };

/** Section label shown in Window Spaces for each work_status. */
export const SECTION_BY_WORK: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  "in-progress": "In Progress",
  "in-review": "In Review",
  done: "Done",
};

function api(app: App): WindowSpacesApi | null {
  // `app.plugins` is undocumented; narrow each hop instead of trusting a shape.
  const registry: unknown = Reflect.get(app, "plugins");
  const plugins: unknown = registry && typeof registry === "object" ? Reflect.get(registry, "plugins") : null;
  const plugin: unknown = plugins && typeof plugins === "object" ? Reflect.get(plugins, "window-spaces") : null;
  const candidate: unknown = plugin && typeof plugin === "object" ? Reflect.get(plugin, "api") : null;
  if (!candidate || typeof candidate !== "object" || !("ensureSpaceForFile" in candidate)) return null;
  // The fork's `api` object is the contract declared above; presence of its entry point is checked.
  const ws = candidate as WindowSpacesApi;
  return ws;
}

/**
 * Mirror a project's statuses onto its Window Space: live projects get a space in the
 * section of their work_status; won/lost projects have theirs archived.
 */
export async function syncProjectSpace(app: App, project: TFile, fm: Record<string, unknown>): Promise<void> {
  const ws = api(app);
  const loc = locate(project.path);
  if (!ws || !loc) return;
  const section = SECTION_BY_WORK[String(fm.work_status)] ?? SECTION_BY_WORK.backlog!;
  const live = Boolean(LIVE_OPP[String(fm.opp_status)]);
  const existing = ws.findSpaceByName(loc.folder);
  if (!existing) {
    if (!live) return;
    const canvas = app.vault.getAbstractFileByPath(canvasPath(loc.root, loc.folder));
    await ws.ensureSpaceForFile(canvas instanceof TFile ? canvas : project, { name: loc.folder, section });
    return;
  }
  if (existing.sections?.[0] !== section) await ws.setSection(existing.id, section);
  if (Boolean(existing.archived) === live) await ws.setArchived(existing.id, !live);
}
