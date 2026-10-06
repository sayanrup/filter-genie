import { useState } from "react";
import { FilterDetailRow } from "@/components/FilterDetail";
import { resultHasDesign } from "@/lib/compare";
import { VALUE_CONFIDENCE_RULE, confidenceOf } from "@/lib/value-confidence";
import type { Evidence, FilterResult } from "@/lib/filter-gen";
import {
  axisMatchText,
  dimensionArea,
  overallRange,
  rangeText,
  sizeText,
  type DimensionAxis,
  type DimensionSpec,
} from "@/lib/ranges";

const fmtNum = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 4 });

/** One axis of a size filter as a slider: lower and upper limit at its ends, a tick for every size in the data. */
function AxisSlider({ axis, unit, ticks }: { axis: DimensionAxis; unit: string; ticks: number[] }) {
  const span = axis.max - axis.min;
  const at = (n: number) => (span > 0 ? ((n - axis.min) / span) * 100 : 50);
  return (
    <li className="text-[11px]">
      <div className="flex items-center gap-1.5">
        <span className="w-14 shrink-0 font-semibold">{axis.name}</span>
        <span className="font-mono">{fmtNum(axis.min)}</span>
        <div
          className="relative h-1.5 min-w-12 flex-1 rounded-full bg-secondary"
          role="img"
          aria-label={`${axis.name}: ${fmtNum(axis.min)} to ${fmtNum(axis.max)} ${unit}`}
        >
          <div className="absolute inset-y-0 left-0 right-0 rounded-full bg-primary/40" />
          {[...new Set(ticks)].map((t) => (
            <span
              key={t}
              style={{ left: `${at(t)}%` }}
              className="absolute -top-0.5 h-2.5 w-px bg-foreground/40"
            />
          ))}
          <span className="absolute -top-1 left-0 size-3 rounded-full border-2 border-primary bg-card" />
          <span className="absolute -top-1 right-0 size-3 rounded-full border-2 border-primary bg-card" />
        </div>
        <span className="font-mono">{fmtNum(axis.max)}</span>
        <span className="text-muted-foreground">{unit}</span>
      </div>
      <div className="pl-[3.875rem] text-[9px] text-muted-foreground">
        {axisMatchText(axis.match)}
      </div>
    </li>
  );
}

/** A size filter ("10x12 ft"): one slider per axis, then (on click) the standard sizes behind them. */
function DimensionView({
  spec,
  levelOf,
  open,
  onToggle,
}: {
  spec: DimensionSpec;
  levelOf: Map<string, { level: keyof typeof LEVEL_CLS; why: string }>;
  open: boolean;
  onToggle: () => void;
}) {
  const area = dimensionArea(spec);
  return (
    <div>
      <ul className="space-y-1.5">
        {spec.axes.map((a) => (
          <AxisSlider
            key={a.name}
            axis={a}
            unit={spec.unit}
            ticks={spec.options.flatMap((o) => (a.name in o.sizes ? [o.sizes[a.name]!] : []))}
          />
        ))}
      </ul>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
        {area ? (
          <span>
            Area {fmtNum(area.min)} – {fmtNum(area.max)} {area.unit}
          </span>
        ) : null}
        <span>{spec.rotation_ok ? "length and width can swap" : "order matters"}</span>
      </div>
      {spec.note ? (
        <div className="mt-1 text-[10px] leading-snug text-muted-foreground">{spec.note}</div>
      ) : null}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        aria-expanded={open}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary-soft px-2.5 py-1.5 font-mono text-[11px] font-semibold text-primary hover:border-primary"
      >
        <span className="text-[9px]">{open ? "▼" : "▶"}</span>
        {spec.options.length} sizes
      </button>
      {open ? (
        <ul
          onClick={(e) => e.stopPropagation()}
          className="mt-2 divide-y divide-border rounded-md border border-border bg-card text-[11px]"
        >
          {spec.options.map((o) => {
            const c = levelOf.get(o.value);
            return (
              <li key={o.value} className="flex items-center gap-2 px-2 py-1.5">
                <span className="min-w-0 flex-1 font-medium">{o.value}</span>
                <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">
                  {sizeText(spec, o)}
                </span>
                {c ? (
                  <span
                    title={c.why}
                    className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${LEVEL_CLS[c.level]}`}
                  >
                    {c.level}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

const LEVEL_CLS = {
  High: "bg-success-soft text-success",
  Medium: "bg-warning-soft text-warning",
  Low: "bg-danger-soft text-destructive",
} as const;

const TIER_ORDER: Record<string, number> = { "Tier 1": 0, "Tier 2": 1, "Tier 3": 2 };

/** Left-edge accent of a value chip, by its confidence. */
const CHIP_ACCENT = {
  High: "border-l-success",
  Medium: "border-l-warning",
  Low: "border-l-destructive",
} as const;
const LEVEL_RANK = { High: 0, Medium: 1, Low: 2 } as const;
const isOther = (v: string) => /^other/i.test(v.trim());

/**
 * A filter's values for display, most confident first (High, Medium, Low), "Other" last, and the
 * options without a confidence after the measured ones. Ties keep the order they came in (demand).
 */
function orderedValues(
  values: string[],
  level: (v: string) => keyof typeof LEVEL_RANK | undefined,
) {
  const rank = (v: string) => (isOther(v) ? 4 : level(v) !== undefined ? LEVEL_RANK[level(v)!] : 3);
  return values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i)
    .map((x) => x.v);
}
/** Options of a numeric filter from lowest to highest bound; options without a range go last. */
function orderedByRange(
  values: string[],
  ranges: { value: string; min: number | null; max: number | null }[],
) {
  // Lower bound first (no lower bound = "less than", so first), then upper bound (none = "more than", so last).
  const by = new Map(ranges.map((r) => [r.value, r]));
  const low = (v: string) => (by.has(v) ? (by.get(v)!.min ?? -Infinity) : Infinity);
  const high = (v: string) => (by.has(v) ? (by.get(v)!.max ?? Infinity) : Infinity);
  return [...values].sort((a, b) => {
    const dl = low(a) - low(b);
    return Number.isNaN(dl) || dl === 0 ? high(a) - high(b) || 0 : dl;
  });
}

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
  const [rangeOpen, setRangeOpen] = useState<Record<string, boolean>>({});
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {[
              "#",
              "Tier",
              "Filter",
              ...(hasDesign ? ["UI pattern"] : []),
              "Values",
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
              const vc = confidenceOf(f, evidence);
              const levelOf = new Map((vc ?? []).map((v) => [v.value, v]));
              const rangeOf = new Map((f.ranges ?? []).map((r) => [r.value, r]));
              // A numeric filter shows one range in its Values cell; a click opens each option's own range.
              const whole = overallRange(f.ranges);
              const rangesShown = Boolean(rangeOpen[key]);
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
                  {hasDesign ? <td className="px-3 py-3 text-xs">{f.ui_pattern}</td> : null}
                  <td className="min-w-56 max-w-80 px-3 py-3">
                    {f.dimensions ? (
                      <DimensionView
                        spec={f.dimensions}
                        levelOf={levelOf}
                        open={rangesShown}
                        onToggle={() => setRangeOpen((o) => ({ ...o, [key]: !o[key] }))}
                      />
                    ) : whole ? (
                      <>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRangeOpen((o) => ({ ...o, [key]: !o[key] }));
                          }}
                          aria-expanded={rangesShown}
                          title="Lowest to highest bound across this filter's options. Click to see each option's range."
                          className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary-soft px-2.5 py-1.5 font-mono text-[11px] font-semibold text-primary hover:border-primary"
                        >
                          <span className="text-[9px]">{rangesShown ? "▼" : "▶"}</span>
                          Range {rangeText(whole)}
                          <span className="font-sans text-[10px] font-medium text-muted-foreground">
                            · {f.ranges!.length} options
                          </span>
                        </button>
                        {rangesShown ? (
                          <ul
                            onClick={(e) => e.stopPropagation()}
                            className="mt-2 divide-y divide-border rounded-md border border-border bg-card text-[11px]"
                          >
                            {orderedByRange(f.values, f.ranges!).map((v) => {
                              const c = levelOf.get(v);
                              const r = rangeOf.get(v);
                              return (
                                <li key={v} className="flex items-center gap-2 px-2 py-1.5">
                                  <span className="min-w-0 flex-1 font-medium">{v}</span>
                                  <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">
                                    {r ? rangeText(r) : "no range"}
                                  </span>
                                  {r?.fill_pct != null ? (
                                    <span
                                      title={`${r.listings} listings have a value in this range`}
                                      className="font-mono text-[10px] whitespace-nowrap text-foreground"
                                    >
                                      fill {r.fill_pct}%
                                    </span>
                                  ) : null}
                                  {c ? (
                                    <span
                                      title={c.why}
                                      className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${LEVEL_CLS[c.level]}`}
                                    >
                                      {c.level}
                                    </span>
                                  ) : null}
                                </li>
                              );
                            })}
                            {f.exact_values?.length ? (
                              <li className="px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
                                Grouped from the exact values: {f.exact_values.join(", ")}.
                              </li>
                            ) : null}
                          </ul>
                        ) : null}
                      </>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {orderedValues(f.values, (v) => levelOf.get(v)?.level)
                          .slice(0, 15)
                          .map((v, vi) => {
                            const c = levelOf.get(v);
                            return (
                              <span
                                key={`${v}-${vi}`}
                                title={c?.why}
                                className={`inline-flex items-stretch overflow-hidden rounded-md border border-border bg-card text-[11px] leading-none shadow-sm ${
                                  c ? `border-l-[3px] ${CHIP_ACCENT[c.level]}` : ""
                                }`}
                              >
                                <span className="px-2 py-1.5 font-medium">{v}</span>
                                {rangeOf.has(v) ? (
                                  <span
                                    title="Lower and upper bound of this option, for searching by number"
                                    className="flex items-center border-l border-border bg-secondary/60 px-1.5 font-mono text-[9px] text-muted-foreground"
                                  >
                                    {rangeText(rangeOf.get(v)!)}
                                  </span>
                                ) : null}
                                {c ? (
                                  <span
                                    className={`flex items-center border-l border-border px-1.5 text-[9px] font-bold uppercase tracking-wider ${LEVEL_CLS[c.level]}`}
                                  >
                                    {c.level}
                                  </span>
                                ) : null}
                              </span>
                            );
                          })}
                        {f.values.length > 15 ? (
                          <span className="rounded-md border border-dashed border-border px-2 py-1.5 text-[11px] leading-none text-muted-foreground">
                            +{f.values.length - 15} more
                          </span>
                        ) : null}
                      </div>
                    )}
                    {f.ai_values?.length ? (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span
                          title="Values the AI suggests adding to the seller form for this filter. They are not on listings yet, so they have no confidence or fill rate."
                          className="text-[9px] font-bold uppercase tracking-wider text-primary"
                        >
                          AI suggested
                        </span>
                        {f.ai_values.map((v) => (
                          <span
                            key={v}
                            className="rounded-md border border-dashed border-primary/50 bg-primary-soft px-2 py-1.5 text-[11px] leading-none font-medium text-primary"
                          >
                            {v}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </td>
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
                      colSpan={hasDesign ? 7 : 6}
                    />,
                  ]
                : [row];
            })}
        </tbody>
      </table>
      {result.filters.some((f) => confidenceOf(f, evidence)?.length) ? (
        <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          {VALUE_CONFIDENCE_RULE}
        </p>
      ) : null}

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
