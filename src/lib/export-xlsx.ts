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
  return wb;
}

/** Builds the workbook and downloads it as an .xlsx file. */
export function downloadWorkbook(fileName: string, opts: Parameters<typeof buildWorkbook>[0]) {
  XLSX.writeFile(buildWorkbook(opts), fileName);
}
