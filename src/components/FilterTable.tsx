import { useState } from "react";
import { FilterDetailRow } from "@/components/FilterDetail";
import { resultHasDesign } from "@/lib/compare";
import type { Evidence, FilterResult } from "@/lib/filter-gen";

const TIER_ORDER: Record<string, number> = { "Tier 1": 0, "Tier 2": 1, "Tier 3": 2 };

/** The ranked filter table (click a row for its full reasoning), plus interaction rules and blockers. */
export function FilterTable({
  result,
  evidence,
  hasDesign = resultHasDesign(result),
}: {
  result: FilterResult;
  evidence: Evidence;
  hasDesign?: boolean;
}) {
  const [expandedFilter, setExpandedFilter] = useState<string | null>(null);
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {[
              "#",
              "Tier",
              "Filter",
              ...(hasDesign ? ["UI pattern", "Values"] : []),
              "Confidence",
              "Why",
            ].map((h) => (
              <th
                key={h}
                className="label-caps border-b-2 border-border px-3 py-2.5 text-left whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...result.filters]
            .sort(
              (a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) || a.rank - b.rank,
            )
            .flatMap((f, i) => {
              const key = `${f.name}-${i}`;
              const open = expandedFilter === key;
              const row = (
                <tr
                  key={key}
                  onClick={() => setExpandedFilter(open ? null : key)}
                  className={`cursor-pointer border-b border-border align-top transition-colors last:border-0 hover:bg-accent/50 ${
                    open ? "border-b-0 bg-accent/40" : ""
                  }`}
                  title={open ? "Click to collapse" : "Click to see the full reasoning"}
                >
                  <td className="px-3 py-3 font-semibold">{i + 1}</td>
                  <td className="px-3 py-3">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider whitespace-nowrap ${
                        f.tier === "Tier 1"
                          ? "bg-success-soft text-success"
                          : f.tier === "Tier 2"
                            ? "bg-warning-soft text-warning"
                            : "bg-danger-soft text-destructive"
                      }`}
                    >
                      {f.tier}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <strong>{f.name}</strong>
                    <div className="mt-1 flex flex-wrap gap-x-2 font-mono text-[10px] text-muted-foreground">
                      {f.coverage_pct != null ? <span>coverage {f.coverage_pct}%</span> : null}
                      {f.top_value_share_pct != null ? (
                        <span>top value {f.top_value_share_pct}%</span>
                      ) : null}
                      {f.listing_fill_pct != null ? (
                        <span>filled {f.listing_fill_pct}%</span>
                      ) : null}
                    </div>
                    {f.needs_new_isq ? (
                      <div className="mt-1 text-[10px] text-destructive">
                        ⚠ {f.isq_note || "Needs a new listing field"}
                      </div>
                    ) : null}
                  </td>
                  {hasDesign ? (
                    <>
                      <td className="px-3 py-3 text-xs">{f.ui_pattern}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          {f.values.slice(0, 15).map((v, vi) => (
                            <span
                              key={`${v}-${vi}`}
                              className="rounded border border-border bg-secondary px-1.5 py-px text-[11px]"
                            >
                              {v}
                            </span>
                          ))}
                          {f.values.length > 15 ? (
                            <span className="rounded border border-border px-1.5 py-px text-[11px] text-muted-foreground">
                              +{f.values.length - 15}
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </>
                  ) : null}
                  <td className="px-3 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                        f.confidence === "High"
                          ? "bg-success-soft text-success"
                          : f.confidence === "Medium"
                            ? "bg-warning-soft text-warning"
                            : "bg-danger-soft text-destructive"
                      }`}
                    >
                      {f.confidence}
                    </span>
                  </td>
                  <td className="max-w-72 px-3 py-3 text-xs text-muted-foreground">
                    <div className="flex items-start gap-1.5">
                      <span
                        className={`mt-0.5 shrink-0 text-[9px] text-muted-foreground/70 transition-transform ${open ? "rotate-90" : ""}`}
                      >
                        ▶
                      </span>
                      <span>{f.rationale}</span>
                    </div>
                    {f.sources?.length ? (
                      <div className="mt-1 ml-3.5 flex flex-wrap gap-1">
                        {f.sources.map((s) => (
                          <span
                            key={s}
                            className="rounded bg-secondary px-1 py-px font-mono text-[9px] uppercase"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
              return open
                ? [
                    row,
                    <FilterDetailRow
                      key={`${key}-detail`}
                      filter={f}
                      evidence={evidence}
                      colSpan={hasDesign ? 7 : 5}
                    />,
                  ]
                : [row];
            })}
        </tbody>
      </table>

      {result.interaction_rules?.length || result.blockers?.length ? (
        <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-2">
          {result.interaction_rules?.length ? (
            <div>
              <h3 className="label-caps mb-1">Interaction rules</h3>
              <ul className="list-disc pl-4 text-xs leading-relaxed">
                {result.interaction_rules.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {result.blockers?.length ? (
            <div>
              <h3 className="label-caps mb-1 text-destructive">Blockers</h3>
              <ul className="list-disc pl-4 text-xs leading-relaxed text-destructive">
                {result.blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
