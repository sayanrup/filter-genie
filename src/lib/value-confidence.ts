import type { DimensionStats } from "./data";
import type { Evidence, FilterRow } from "./filter-gen";

export type ValueLevel = "High" | "Medium" | "Low";

export interface ValueConfidence {
  value: string;
  level: ValueLevel;
  /** Plain-words evidence for a tooltip. */
  why: string;
  /**
   * Fill rate: % of the listings that fill the linked spec and carry this value (null: on no listing).
   * Orders values within a confidence level (rankValues). Absent on results saved before it was stored.
   */
  fill_pct?: number | null;
  /** How many listings carry it. */
  listings?: number;
  /** % of the linked keyword dimension's demand this value holds (null: not in the keywords). */
  demand_pct?: number | null;
  /**
   * Where the value came from (skill 15): the filter's own values ("data"), a listing value added because the
   * ISQ was thin ("listing"), or the category document ("doc"). Absent on results from before that step.
   */
  source?: "data" | "listing" | "doc";
  /** The category document lists this value, which raised its level by one. */
  lifted?: boolean;
}

/**
 * The confidence of a value as shown next to it: the one stored on the filter when the run made it
 * (so saved results keep it), else computed from the evidence for results saved before it was stored.
 */
export function confidenceOf(
  filter: FilterRow,
  evidence: Pick<Evidence, "aggregation" | "listing">,
): ValueConfidence[] | null {
  return filter.value_confidence ?? valueConfidence(filter, evidence);
}

/** "House (High), Toilet (Medium)": values with their confidence, for exports. */
export function valuesWithConfidence(filter: FilterRow): string[] {
  const byValue = new Map((filter.value_confidence ?? []).map((v) => [v.value, v.level]));
  return rankValues(filter.values ?? [], filter.value_confidence).map((v) =>
    byValue.has(v) ? `${v} (${byValue.get(v)})` : v,
  );
}

/** Reverse of valuesWithConfidence(): "House (High)" → value "House", level "High". */
export function splitValueLevel(text: string): { value: string; level: ValueLevel | null } {
  const m = text.match(/^(.*\S)\s*\((High|Medium|Low)\)$/);
  return m ? { value: m[1]!, level: m[2] as ValueLevel } : { value: text, level: null };
}

/** A value holding at least this share (%) of the demand or listings is a clear leader. */
export const HIGH_AT = 20;
/** …and at least this share is a real but smaller option; below it, or unseen, is Low. */
export const MEDIUM_AT = 5;

export const VALUE_CONFIDENCE_RULE = `Value confidence: High = the value holds ≥ ${HIGH_AT}% of the keyword demand or of the listings that fill this spec · Medium = ≥ ${MEDIUM_AT}% · Low = less than that, or not seen in your data (suggested by the model).`;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const stem = (s: string) => norm(s).replace(/s$/, "");

/**
 * The data entries that are this value: equal ignoring case, punctuation and a plural "s". Loose
 * "contains" matching is deliberately not used, so "Site Office" never borrows the numbers of "Office".
 */
function matches<T>(items: T[], name: (t: T) => string, value: string): T[] {
  const v = stem(value);
  return v ? items.filter((t) => stem(name(t)) === v) : [];
}

const level = (share: number): ValueLevel =>
  share >= HIGH_AT ? "High" : share >= MEDIUM_AT ? "Medium" : "Low";

/**
 * A High / Medium / Low tag for each value of a filter, from how much of the keyword demand and of
 * the listings that value actually holds. Returns null when the filter has no linked keyword
 * dimension or listing spec (nothing to measure against), e.g. a filter from context alone or a
 * saved result that doesn't carry its evidence.
 */
export function valueConfidence(
  filter: FilterRow,
  evidence: Pick<Evidence, "aggregation" | "listing">,
): ValueConfidence[] | null {
  const dim = filter.linked_dimension
    ? evidence.aggregation?.dimensions.find((d) => norm(d.name) === norm(filter.linked_dimension!))
    : undefined;
  const spec = filter.linked_listing_spec
    ? evidence.listing?.fields.find((f) => norm(f.key) === norm(filter.linked_listing_spec!))
    : undefined;
  if (!dim && !spec) return null;

  const specs = spec ? [{ key: spec.key, filled: spec.filled, values: spec.top }] : [];
  return (
    (filter.values ?? [])
      // "Other" is a catch-all bucket, not a value anyone measures.
      .filter((v) => v.trim() && norm(v) !== "other")
      .map((value) => {
        const s = scoreValue(value, dim, specs);
        return withData(s);
      })
  );
}

/** A listing spec as scoreValue() reads it: its name, how many listings fill it, and its values with counts. */
export interface SpecValues {
  key: string;
  filled: number;
  values: [string, number][];
}

/**
 * One value's confidence by the rule above, plus the share it was judged on (for ranking candidates).
 * `specs` can hold more than one listing spec: a category manager's value is also looked up under the
 * spec named like the manager's ISQ (skill 15).
 */
export function scoreValue(
  value: string,
  dim: DimensionStats | undefined,
  specs: SpecValues[],
): ValueConfidence & { share: number } {
  const parts: string[] = [];
  let best = 0;
  let demandPct: number | null = null;
  let fillPct: number | null = null;
  let listings = 0;

  const dvs = dim ? matches(dim.values, (d) => d.value, value) : [];
  if (dim && dvs.length) {
    const share = Math.max(
      0,
      ...dvs.flatMap((d) => Object.values(d.bySource).map((b) => b?.share ?? 0)),
    );
    best = Math.max(best, share);
    demandPct = share;
    parts.push(`${share}% of the keyword demand for ${dim.name}`);
  }

  for (const spec of specs) {
    const lv = matches(spec.values, ([v]) => v, value);
    if (!lv.length) continue;
    const count = lv.reduce((s, [, n]) => s + n, 0);
    const share = spec.filled ? Math.round((count / spec.filled) * 1000) / 10 : 0;
    best = Math.max(best, share);
    if (fillPct === null || share > fillPct) {
      fillPct = share;
      listings = count;
    }
    parts.push(`${share}% of the listings that fill ${spec.key} (${count})`);
  }

  const data = { fill_pct: fillPct, listings, demand_pct: demandPct };
  if (!parts.length)
    return {
      value,
      level: "Low",
      why: "Not seen in the keyword or listing data",
      share: 0,
      ...data,
    };
  return { value, level: level(best), why: parts.join(" · "), share: best, ...data };
}

/** A scored value as stored on a filter: its confidence and the numbers behind it, without the ranking share. */
export function withData(s: ValueConfidence): ValueConfidence {
  return {
    value: s.value,
    level: s.level,
    why: s.why,
    fill_pct: s.fill_pct ?? null,
    listings: s.listings ?? 0,
    demand_pct: s.demand_pct ?? null,
  };
}

const LEVEL_RANK: Record<ValueLevel, number> = { High: 0, Medium: 1, Low: 2 };
const isOther = (v: string) => /^other\b/i.test(v.trim());

/**
 * A filter's values in rank order: by confidence (High, Medium, Low), then by fill rate (share of the listings
 * that fill the spec), then by keyword demand share, then in the order they came in. Values with no confidence
 * come after the measured ones and "Other" goes last. The table and the JSON export both use this order.
 */
export function rankValues(values: string[], vc: ValueConfidence[] | null | undefined): string[] {
  const by = new Map((vc ?? []).map((c) => [c.value, c]));
  const key = (v: string) => {
    const c = by.get(v);
    return {
      group: isOther(v) ? 4 : c ? LEVEL_RANK[c.level] : 3,
      fill: c?.fill_pct ?? -1,
      demand: c?.demand_pct ?? -1,
    };
  };
  return values
    .map((v, i) => ({ v, i, k: key(v) }))
    .sort(
      (a, b) =>
        a.k.group - b.k.group || b.k.fill - a.k.fill || b.k.demand - a.k.demand || a.i - b.i,
    )
    .map((x) => x.v);
}
