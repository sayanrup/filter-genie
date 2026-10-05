/**
 * IndiaMART's MCAT skill-context API: one call returns ~14 markdown research files for an MCAT.
 * We pick the Seller & Buyer Spec Audit out of it and turn its tables into JSON.
 *
 * The API is internal (plain http, office network only, no CORS), so the browser can't call it —
 * `/api/mcat-context` fetches it on the app's server instead.
 */

export const MCAT_CONTEXT_API = "http://glrapi.imutils.com/r/product/mcatskillcontext";
export const SPEC_AUDIT_FILE = "seller_and_buyer_spec_audit.md";

interface ContextFile {
  fileName: string;
  format: string;
  data: string;
}

interface ContextResponse {
  Code: string;
  Msg: string;
  Data: { contextFiles?: ContextFile[]; mcat_id?: string; subcatId?: string } | null;
}

export type Json = string | number | null | string[] | { [key: string]: Json } | Json[];

export interface SpecAudit {
  mcat_id: string;
  subcat_id: string | null;
  mcat_name: string | null;
  /** One key per section, named after its heading: a table becomes rows, a Field | Value table an object. */
  [section: string]: Json;
}

export interface McatContext {
  audit: SpecAudit;
  /** The audit as it came, minus the glossary — what goes into the category context input. */
  markdown: string;
}

/** Columns and bold fields that hold comma-separated lists. */
const LIST_KEYS = new Set([
  "values",
  "options",
  "example_values",
  "current_quantity_units",
  "thumbnail_eligible_specs",
]);
const NUMBER_KEYS = new Set(["rank", "current_rank", "preferred_rank"]);
const EMPTY = /^(—|-|_?none( flagged)?_?|n\/a)?$/i;

export async function fetchMcatContext(mcatId: string, signal?: AbortSignal): Promise<McatContext> {
  const resp = await fetch(`${MCAT_CONTEXT_API}?mcat_id=${encodeURIComponent(mcatId)}`, {
    signal: signal ?? null,
  });
  if (!resp.ok) throw new Error(`MCAT API answered ${resp.status}`);
  const body = (await resp.json()) as ContextResponse;
  // A bad id still comes back as HTTP 200, with Code "400" and the reason in Msg.
  if (body.Code !== "200" || !body.Data) throw new Error(body.Msg || `MCAT API code ${body.Code}`);

  const files = body.Data.contextFiles ?? [];
  const audit = files.find((f) => f.fileName === SPEC_AUDIT_FILE);
  if (!audit) throw new Error(`MCAT ${mcatId} has no ${SPEC_AUDIT_FILE}`);
  const index = files.find((f) => f.fileName === "index.md")?.data ?? "";
  const name = index.match(/\*\*Mcat Name:\*\*\s*(.+)/)?.[1]?.trim() ?? null;

  const text = audit.data
    .split(/\n## Glossary/i)[0]!
    .replace(/\n-{3,}\s*$/, "")
    .trim();
  return {
    audit: {
      mcat_id: body.Data.mcat_id ?? mcatId,
      subcat_id: body.Data.subcatId ?? null,
      mcat_name: name,
      ...parseSpecAudit(text),
    },
    // The file's own title doesn't say which category it is; the context input needs that.
    markdown: name ? text.replace(/^# .*/, `# ${name} — Seller & Buyer Spec Audit`) : text,
  };
}

/**
 * "### 3a. Current Buyer Spec Audit" → `current_buyer_spec_audit`. Each section's table becomes
 * rows keyed by its column names; a two-column Field | Value table becomes one object; a section
 * that only says "_No missing seller specs identified._" becomes []. Bold `**Key:** value` lines
 * become top-level keys (`mcat_id`, `generated`, `thumbnail_eligible_specs`).
 */
export function parseSpecAudit(markdown: string): Record<string, Json> {
  const out: Record<string, Json> = {};
  let section = "";
  let table: string[][] = [];
  let hasText = false;

  const flush = () => {
    if (section && table.length) out[section] = tableJson(table);
    else if (section && hasText) out[section] = [];
    table = [];
    hasText = false;
  };

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^#{2,4}\s+(?:\d+[a-z]?\.\s*)?(.+)/);
    if (heading) {
      flush();
      section = slug(heading[1]!);
      continue;
    }
    if (line.trim().startsWith("|")) {
      const cells = splitRow(line);
      if (!cells.every((c) => /^:?-+:?$/.test(c))) table.push(cells);
      continue;
    }
    let bold = false;
    for (const [, key, value] of line.matchAll(/\*\*([^*]+?):\*\*\s*([^|*]*)/g)) {
      const k = slug(key!);
      out[k] = cell(k, value!.trim());
      bold = true;
    }
    if (!bold && line.trim() && !line.startsWith("# ")) hasText = true;
  }
  flush();
  return out;
}

function tableJson(table: string[][]): Json {
  const [header, ...rows] = table;
  const keys = header!.map(slug);
  if (keys.length === 2 && keys[0] === "field") {
    const obj: Record<string, Json> = {};
    for (const [f = "", v = ""] of rows) obj[slug(f)] = cell(slug(f), v);
    return obj;
  }
  return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, cell(k, r[i] ?? "")])));
}

function cell(key: string, raw: string): Json {
  const v = raw.replace(/\\\|/g, "|").trim();
  if (LIST_KEYS.has(key)) return EMPTY.test(v) ? [] : splitList(v);
  if (EMPTY.test(v)) return null;
  if (NUMBER_KEYS.has(key) && /^\d+$/.test(v)) return Number(v);
  return v;
}

/** Split on commas that aren't inside brackets: "MS (Mild Steel, IS 2062), GI" → 2 items. */
function splitList(v: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else cur += ch;
  }
  items.push(cur);
  return items.map((s) => s.trim()).filter(Boolean);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

function slug(s: string): string {
  return s
    .replace(/[*_`]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}
