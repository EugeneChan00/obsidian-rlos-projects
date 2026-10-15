import type { App } from "obsidian";
import { SCHEMA_PATH } from "./model";

export type NoteType = "project" | "revision" | "po";

interface Rule {
  $ref?: string;
  const?: unknown;
  enum?: unknown[];
  type?: "string" | "number" | "integer" | "array" | "object";
  pattern?: string;
  minimum?: number;
  maximum?: number;
  required?: string[];
  properties?: Record<string, Rule>;
}

interface SchemaDoc {
  $defs: Record<string, Rule>;
}

export interface Violation {
  key: string;
  message: string;
}

/** Subset of JSON Schema used by policy/schemas/projects.schema.json. */
export class ProjectSchema {
  private constructor(private readonly defs: Record<string, Rule>) {}

  static async load(app: App): Promise<ProjectSchema> {
    const doc = JSON.parse(await app.vault.adapter.read(SCHEMA_PATH)) as SchemaDoc;
    return new ProjectSchema(doc.$defs);
  }

  enumOf(def: "workStatus" | "oppStatus" | "revStatus" | "priority" | "productType"): string[] {
    return (this.defs[def]?.enum ?? []) as string[];
  }

  validate(type: NoteType, fm: Record<string, unknown>): Violation[] {
    const rule = this.defs[type];
    if (!rule) return [{ key: "type", message: `unknown note type ${type}` }];
    const out: Violation[] = [];
    for (const key of rule.required ?? []) {
      if (fm[key] === undefined || fm[key] === null) out.push({ key, message: "missing" });
    }
    for (const [key, sub] of Object.entries(rule.properties ?? {})) {
      const value = fm[key];
      if (value === undefined || value === null) continue;
      const message = this.check(sub, value);
      if (message) out.push({ key, message });
    }
    return out;
  }

  private check(rule: Rule, value: unknown): string | null {
    if (rule.$ref) {
      const target = this.defs[rule.$ref.replace("#/$defs/", "")];
      return target ? this.check(target, value) : `unresolved ${rule.$ref}`;
    }
    if (rule.const !== undefined && value !== rule.const) return `expected ${JSON.stringify(rule.const)}`;
    if (rule.enum && !rule.enum.includes(value)) return `${JSON.stringify(value)} not in [${rule.enum.join(", ")}]`;
    switch (rule.type) {
      case "string":
        if (typeof value !== "string") return `expected string, got ${typeof value}`;
        if (rule.pattern && !new RegExp(rule.pattern).test(value)) return `${JSON.stringify(value)} does not match ${rule.pattern}`;
        break;
      case "number":
      case "integer":
        if (typeof value !== "number" || Number.isNaN(value)) return `expected number, got ${JSON.stringify(value)}`;
        if (rule.type === "integer" && !Number.isInteger(value)) return "expected integer";
        if (rule.minimum !== undefined && value < rule.minimum) return `below ${rule.minimum}`;
        if (rule.maximum !== undefined && value > rule.maximum) return `above ${rule.maximum}`;
        break;
      case "array":
        if (!Array.isArray(value)) return "expected list";
        break;
    }
    return null;
  }
}
