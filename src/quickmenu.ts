import type { App } from "obsidian";

/** One entry of the QuickAdd menu (Alt+Q) that this plugin owns. */
export interface MenuEntry {
  /** Stable choice id; managed choices are recognised by the `rlos-` prefix. */
  id: string;
  name: string;
  step: { type: "Obsidian"; commandId: string } | { type: "UserScript"; path: string };
}

const MANAGED = "rlos-";
const QUICKADD = "quickadd";

type Json = Record<string, unknown>;

function choiceFor(e: MenuEntry): Json {
  const step: Json =
    e.step.type === "Obsidian"
      ? { id: `${e.id}-step`, name: e.step.commandId, type: "Obsidian", commandId: e.step.commandId }
      : { id: `${e.id}-step`, name: e.step.path.split("/").pop()!.replace(/\.js$/, ""), type: "UserScript", path: e.step.path, settings: {} };
  return {
    id: e.id,
    name: e.name,
    type: "Macro",
    command: false,
    runOnStartup: false,
    macro: { id: `${e.id}-macro`, name: e.name, commands: [step] },
  };
}

const plugins = (app: App): Json | null => {
  const p: unknown = Reflect.get(app, "plugins");
  return p && typeof p === "object" ? (p as Json) : null;
};

export type MenuSyncResult = "quickadd-missing" | "unchanged" | "updated";

/**
 * Put the managed entries at the top of QuickAdd's menu. User choices stay, except one whose name
 * equals a managed entry's name (case-insensitive): the managed entry replaces it.
 * QuickAdd keeps its settings in a store, so the file is written and the plugin reloaded.
 */
export async function syncQuickAddMenu(app: App, entries: MenuEntry[]): Promise<MenuSyncResult> {
  const registry = plugins(app);
  const manifests: unknown = registry ? Reflect.get(registry, "manifests") : null;
  if (!manifests || typeof manifests !== "object" || !(QUICKADD in manifests)) return "quickadd-missing";

  const path = `${app.vault.configDir}/plugins/${QUICKADD}/data.json`;
  const adapter = app.vault.adapter;
  let data: Json = {};
  if (await adapter.exists(path)) {
    const parsed: unknown = JSON.parse(await adapter.read(path));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Json;
  }
  const existing: unknown[] = Array.isArray(data.choices) ? data.choices : [];
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  const kept = existing.filter((c) => {
    if (!c || typeof c !== "object") return false;
    const id: unknown = Reflect.get(c, "id");
    const name: unknown = Reflect.get(c, "name");
    if (typeof id === "string" && id.startsWith(MANAGED)) return false;
    return !(typeof name === "string" && names.has(name.toLowerCase()));
  });
  const choices = [...entries.map(choiceFor), ...kept];
  if (JSON.stringify(choices) === JSON.stringify(existing)) return "unchanged";

  await adapter.write(path, JSON.stringify({ ...data, choices }, null, 2));
  const enabled: unknown = registry ? Reflect.get(registry, "enabledPlugins") : null;
  if (enabled instanceof Set && enabled.has(QUICKADD)) {
    const disable: unknown = Reflect.get(registry!, "disablePlugin");
    const enable: unknown = Reflect.get(registry!, "enablePlugin");
    if (typeof disable === "function" && typeof enable === "function") {
      await disable.call(registry, QUICKADD);
      await enable.call(registry, QUICKADD);
    }
  }
  return "updated";
}
