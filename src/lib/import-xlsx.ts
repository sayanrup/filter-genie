import * as XLSX from "xlsx";
import { compareContext } from "./compare";
import type { ContextComparison } from "./compare";
import type { Confidence, FilterResult, FilterRow, Tier } from "./filter-gen";
import { splitValueLevel } from "./value-confidence";

/** What a workbook from "Download .xlsx" holds, read back into results. */
export interface ImportedWorkbook {
  result: FilterResult;
  withoutResult?: FilterResult;
  comparison?: ContextComparison;
}

const TIERS: Tier[] = ["Tier 1", "Tier 2", "Tier 3"];
const CONFIDENCE: Confidence[] = ["High", "Medium", "Low"];

const text = (v: unknown) => (v == null ? "" : String(v).trim());
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(text(v));
  return text(v) === "" || Number.isNaN(n) ? null : n;
};

function readFilters(sheet: XLSX.WorkSheet): FilterRow[] {
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  const out: FilterRow[] = [];
  for (const r of rows) {
    const name = text(r["Filter"]);
    if (!name) continue;
    const tier = TIERS.find((t) => t === text(r["Tier"])) ?? "Tier 3";
    const confidence = CONFIDENCE.find((c) => c === text(r["Confidence"])) ?? "Medium";
    // "House (High), Toilet (Medium)": each value may carry its confidence.
    const parts = text(r["Values"])
      .split(/\s*,\s*/)
      .filter(Boolean)
      .map(splitValueLevel);
    const values = parts.map((p) => p.value);
    const valueConfidence = parts.flatMap((p) =>
      p.level ? [{ value: p.value, level: p.level, why: "Imported from the Excel export" }] : [],
    );
    const sources = text(r["Sources"])
      .split(/\s*,\s*/)
      .filter(Boolean);
    const row: FilterRow = {
      rank: num(r["#"]) ?? out.length + 1,
      tier,
      name,
      ui_pattern: text(r["UI pattern"]),
      values,
      confidence,
      rationale: text(r["Why"]),
      coverage_pct: num(r["Coverage %"]),
      top_value_share_pct: num(r["Top value share %"]),
      listing_fill_pct: num(r["Listing fill %"]),
      needs_new_isq: text(r["Needs new ISQ"]).toLowerCase() === "yes",
      isq_note: text(r["ISQ note"]) || null,
    };
    const aiValues = text(r["AI suggested values"])
      .split(/\s*,\s*/)
      .filter(Boolean);
    if (aiValues.length) row.ai_values = aiValues;
    if (sources.length) row.sources = sources;
    if (valueConfidence.length) row.value_confidence = valueConfidence;
    out.push(row);
  }
  return out;
}

function readRules(sheet: XLSX.WorkSheet | undefined, run: string) {
  const rules: string[] = [];
  const blockers: string[] = [];
  if (!sheet) return { rules, blockers };
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  for (const r of rows) {
    // A workbook with one run has no "Run" column; with two, each row names its run.
    if (r["Run"] !== undefined && text(r["Run"]) !== run) continue;
    (text(r["Type"]) === "Blocker" ? blockers : rules).push(text(r["Text"]));
  }
  return { rules, blockers };
}

function result(filters: FilterRow[], rulesSheet: XLSX.WorkSheet | undefined, run: string) {
  const { rules, blockers } = readRules(rulesSheet, run);
  const out: FilterResult = { filters };
  if (rules.length) out.interaction_rules = rules;
  if (blockers.length) out.blockers = blockers;
  return out;
}

/**
 * Reads a workbook made by "Download .xlsx": sheets "With context" / "Without context" (or a single
 * "Filters"), and "Rules & blockers". The comparison is recomputed from the two filter lists; the
 * per-ISQ match against the specs you gave isn't in the workbook, so it is left out.
 */
export function parseWorkbook(wb: XLSX.WorkBook): ImportedWorkbook {
  const sheets = wb.Sheets;
  const withSheet = sheets["With context"] ?? sheets["Filters"] ?? sheets[wb.SheetNames[0]!];
  if (!withSheet) throw new Error("The workbook has no sheets.");
  const rulesSheet = sheets["Rules & blockers"];
  const both = Boolean(sheets["Without context"]);
  const main = result(readFilters(withSheet), rulesSheet, both ? "With context" : "");
  if (!main.filters.length)
    throw new Error('No filters found: expected a "Filter" column on the first sheet.');
  if (!both) return { result: main };
  const without = result(readFilters(sheets["Without context"]!), rulesSheet, "Without context");
  return { result: main, withoutResult: without, comparison: compareContext(without, main, []) };
}
