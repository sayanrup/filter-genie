import type { Evidence, FilterRow } from "./filter-gen";

export type ValueLevel = "High" | "Medium" | "Low";

export interface ValueConfidence {
  value: string;
  level: ValueLevel;
  /** Plain-words evidence for a tooltip. */
  why: string;
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
  return (filter.values ?? []).map((v) => (byValue.has(v) ? `${v} (${byValue.get(v)})` : v));
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

  return (
    (filter.values ?? [])
      // "Other" is a catch-all bucket, not a value anyone measures.
      .filter((v) => v.trim() && norm(v) !== "other")
      .map((value) => {
        const parts: string[] = [];
        let best = 0;

        const dvs = dim ? matches(dim.values, (d) => d.value, value) : [];
        if (dim && dvs.length) {
          const share = Math.max(
            0,
            ...dvs.flatMap((d) => Object.values(d.bySource).map((b) => b?.share ?? 0)),
          );
          best = Math.max(best, share);
          parts.push(`${share}% of the keyword demand for ${dim.name}`);
        }

        const lv = spec ? matches(spec.top, ([v]) => v, value) : [];
        if (spec && lv?.length) {
          const count = lv.reduce((s, [, n]) => s + n, 0);
          const share = spec.filled ? Math.round((count / spec.filled) * 1000) / 10 : 0;
          best = Math.max(best, share);
          parts.push(`${share}% of the listings that fill ${spec.key} (${count})`);
        }

        if (!parts.length)
          return { value, level: "Low" as const, why: "Not seen in the keyword or listing data" };
        return { value, level: level(best), why: parts.join(" · ") };
      })
  );
}
