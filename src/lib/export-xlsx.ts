import * as XLSX from "xlsx";
import type { ContextComparison } from "./compare";
import type { FilterResult } from "./filter-gen";
import { valuesWithConfidence } from "./value-confidence";

const TIER_ORDER: Record<string, number> = { "Tier 1": 0, "Tier 2": 1, "Tier 3": 2 };

/** Filters as sheet rows, in the same order as the on-screen table (tier, then rank). */
function filterRows(result: FilterResult) {
  return [...result.filters]
    .sort((a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) || a.rank - b.rank)
    .map((f, i) => ({
      "#": i + 1,
      Tier: f.tier,
      Filter: f.name,
      "UI pattern": f.ui_pattern,
      Values: valuesWithConfidence(f).join(", "),
      Confidence: f.confidence,
      Why: f.rationale,
      "Coverage %": f.coverage_pct ?? "",
      "Top value share %": f.top_value_share_pct ?? "",
      "Listing fill %": f.listing_fill_pct ?? "",
      "Needs new ISQ": f.needs_new_isq ? "Yes" : "",
      "ISQ note": f.isq_note ?? "",
      Sources: (f.sources ?? []).join(", "),
    }));
}

/** One row per ISQ value of every filter, with its High / Medium / Low confidence and the evidence for it. */
function valueRows(result: FilterResult) {
  return [...result.filters]
    .sort((a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) || a.rank - b.rank)
    .flatMap((f) => {
      const byValue = new Map((f.value_confidence ?? []).map((v) => [v.value, v]));
      return (f.values ?? []).map((value) => ({
        Tier: f.tier,
        Filter: f.name,
        "UI pattern": f.ui_pattern,
        "ISQ value": value,
        "Value confidence": byValue.get(value)?.level ?? "",
        Evidence: byValue.get(value)?.why ?? "",
      }));
    });
}

const VALUE_WIDTHS = [8, 24, 16, 30, 16, 70];

function rulesRows(result: FilterResult) {
  return [
    ...(result.interaction_rules ?? []).map((text) => ({ Type: "Interaction rule", Text: text })),
    ...(result.blockers ?? []).map((text) => ({ Type: "Blocker", Text: text })),
  ];
}

function similarityRows(cmp: ContextComparison): (string | number)[][] {
  const rows: (string | number)[][] = [
    ["Overlap %", cmp.overlapPct],
    ["Filters in both runs", cmp.shared.length],
    ["Found without context % (of the with-context filters)", cmp.recallPct],
    ["Same tier % (of shared filters)", cmp.shared.length ? cmp.sameTierPct : "n/a"],
    [],
    ["Only with context", cmp.onlyWith.join(", ") || "none"],
    ["Only without context", cmp.onlyWithout.join(", ") || "none"],
  ];
  for (const [label, ref] of [
    ["with context", cmp.refWith],
    ["without context", cmp.refWithout],
  ] as const) {
    if (!ref) continue;
    rows.push(
      [],
      [`Your ISQs found, ${label}`, `${ref.covered.length}/${ref.reference}`],
      [`Missed, ${label}`, ref.missed.join(", ") || "none"],
      [`Extra, ${label}`, ref.extra.join(", ") || "none"],
    );
  }
  if (cmp.shared.length) {
    rows.push([], ["Without context", "Tier", "With context", "Tier"]);
    for (const s of cmp.shared) rows.push([s.without, s.tierWithout, s.withCtx, s.tierWith]);
  }
  return rows;
}

function addSheet(wb: XLSX.WorkBook, name: string, sheet: XLSX.WorkSheet, widths: number[]) {
  sheet["!cols"] = widths.map((wch) => ({ wch }));
  // A filter arrow on every header of the tables (the similarity sheet is a free-form report).
  if (sheet["!ref"] && name !== "How similar") sheet["!autofilter"] = { ref: sheet["!ref"] };
  XLSX.utils.book_append_sheet(wb, sheet, name);
}

const FILTER_WIDTHS = [4, 8, 24, 16, 40, 11, 60, 11, 15, 13, 13, 30, 20];

/** One workbook with everything a Generate produced: filters (with / without context), rules, similarity. */
export function buildWorkbook(opts: {
  result: FilterResult;
  withoutResult?: FilterResult;
  comparison?: ContextComparison;
}): XLSX.WorkBook {
  const { result, withoutResult, comparison } = opts;
  const wb = XLSX.utils.book_new();
  const both = Boolean(withoutResult);
  addSheet(
    wb,
    both ? "With context" : "Filters",
    XLSX.utils.json_to_sheet(filterRows(result)),
    FILTER_WIDTHS,
  );
  if (withoutResult)
    addSheet(
      wb,
      "Without context",
      XLSX.utils.json_to_sheet(filterRows(withoutResult)),
      FILTER_WIDTHS,
    );
  if (comparison)
    addSheet(
      wb,
      "How similar",
      XLSX.utils.aoa_to_sheet(similarityRows(comparison)),
      [52, 40, 40, 12],
    );
  const rules = [
    ...rulesRows(result).map((r) => ({ Run: both ? "With context" : "", ...r })),
    ...(withoutResult
      ? rulesRows(withoutResult).map((r) => ({ Run: "Without context", ...r }))
      : []),
  ];
  if (rules.length)
    addSheet(wb, "Rules & blockers", XLSX.utils.json_to_sheet(rules), [16, 18, 100]);
  const values = valueRows(result);
  if (values.length) addSheet(wb, "ISQ values", XLSX.utils.json_to_sheet(values), VALUE_WIDTHS);
  return wb;
}

/** Builds the workbook and downloads it as an .xlsx file. */
export function downloadWorkbook(fileName: string, opts: Parameters<typeof buildWorkbook>[0]) {
  XLSX.writeFile(buildWorkbook(opts), fileName);
}

/** Excel sheet names: 31 characters at most, none of  / ? * [ ] :, and no two alike. */
function sheetNames(names: string[], taken: string[]): string[] {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  return names.map((n) => {
    const base = (
      n
        .replace(/[\\/?*[\]:]/g, " ")
        .replace(/\s+/g, " ")
        .trim() || "MCAT"
    ).slice(0, 31);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      const suffix = ` (${i})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

export interface McatResult {
  name: string;
  result: FilterResult;
  /** Listings the MCAT had in the product file. */
  listings?: number;
  /** Per keyword file: how many of its keywords were picked for this MCAT (e.g. "Google SERP: 84 of 4,956"). */
  keywords?: string;
}

/**
 * One workbook for a whole subcategory: a summary row per MCAT, every MCAT's filters in one flat sheet
 * (an MCAT column), the rules and blockers, and then one sheet per MCAT with its own filter table.
 */
export function buildMcatWorkbook(items: McatResult[]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const tier = (r: FilterResult, t: string) => r.filters.filter((f) => f.tier === t);
  addSheet(
    wb,
    "Summary",
    XLSX.utils.json_to_sheet(
      items.map(({ name, result, listings, keywords }) => ({
        MCAT: name,
        "MCAT ID": result.mcat_id ?? "",
        "Subcat ID": result.subcat_id ?? "",
        "Subcat name": result.subcat_name ?? "",
        "Primary PMCAT": result.pmcat?.name ?? "",
        Listings: listings ?? "",
        "Keywords picked": keywords ?? "",
        Filters: result.filters.length,
        "Tier 1": tier(result, "Tier 1").length,
        "Tier 2": tier(result, "Tier 2").length,
        "Tier 3": tier(result, "Tier 3").length,
        "Needs new ISQ": result.filters.filter((f) => f.needs_new_isq).length,
        "Tier 1 filters": tier(result, "Tier 1")
          .sort((a, b) => a.rank - b.rank)
          .map((f) => f.name)
          .join(", "),
      })),
    ),
    [28, 11, 10, 34, 30, 9, 40, 9, 7, 7, 7, 13, 70],
  );
  addSheet(
    wb,
    "All filters",
    XLSX.utils.json_to_sheet(
      items.flatMap(({ name, result }) =>
        filterRows(result).map((row) => ({ MCAT: name, "MCAT ID": result.mcat_id ?? "", ...row })),
      ),
    ),
    [28, 11, ...FILTER_WIDTHS],
  );
  const rules = items.flatMap(({ name, result }) =>
    rulesRows(result).map((row) => ({ MCAT: name, ...row })),
  );
  if (rules.length)
    addSheet(wb, "Rules & blockers", XLSX.utils.json_to_sheet(rules), [28, 18, 100]);
  const values = items.flatMap(({ name, result }) =>
    valueRows(result).map((row) => ({ MCAT: name, "MCAT ID": result.mcat_id ?? "", ...row })),
  );
  if (values.length)
    addSheet(wb, "ISQ values", XLSX.utils.json_to_sheet(values), [28, 11, ...VALUE_WIDTHS]);
  const names = sheetNames(
    items.map((i) => i.name),
    ["Summary", "All filters", "Rules & blockers", "ISQ values"],
  );
  items.forEach((item, i) =>
    addSheet(wb, names[i]!, XLSX.utils.json_to_sheet(filterRows(item.result)), FILTER_WIDTHS),
  );
  return wb;
}

/** Builds the subcategory workbook and downloads it as an .xlsx file. */
export function downloadMcatWorkbook(fileName: string, items: McatResult[]) {
  XLSX.writeFile(buildMcatWorkbook(items), fileName);
}
