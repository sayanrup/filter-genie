import type { Evidence, FilterRow } from "./filter-gen";
import type { DocPair } from "./category-doc";
import {
  axisOf,
  conform,
  dominantShape,
  formatQuantity,
  measureKind,
  parseQuantity,
  quantityKey,
  type MeasureKind,
  type Quantity,
  type QuantityShape,
} from "./quantity";
import { HIGH_AT, MEDIUM_AT, type ValueConfidence, type ValueLevel } from "./value-confidence";

/*
 * Skill 15 · which ISQs and which of their values are finally shown. Runs after the check step, all in code
 * (one small model call before it pairs ISQs with the category document, see category-doc.ts):
 *
 *   values   1. measurements (Area, Size, Length, Width, Height…) get one spelling, one unit and one count of
 *               numbers (a Length or Width is one; an Area or Size one, two or three, as the category document
 *               writes it). When the document has the same measurement, the ISQ's values ARE the document's
 *               (paired by name, in code; nothing of ours is added, the data only scores them). Without one,
 *               ours stay, minus what isn't a number with a unit or is in another unit
 *            2. no duplicates: spellings, short and full forms ("MS" / "Mild Steel (MS)"), and a generic value
 *               beside a specific one ("Wood" beside "Pine Wood") are one value
 *            3. thin ISQ (one High value or none): listing values the keywords missed, then the category
 *               document: a Medium / Low value of ours that it lists goes up a level, and up to 3 of its own
 *               values are added (at the level the data gives them, Medium at the least)
 *            4. only High and Medium values are shown; with 4 or more High, only the High ones. Numeric values
 *               are listed smallest first, the rest best first
 *   ISQs     5. Tier 1 at any confidence, Tier 2 only when High; never Tier 3, Price or Location
 *            6. an ISQ needs 2 values to show; two ISQs for one attribute are one
 *            7. with 3 or more Tier 1 High / Medium ISQs, Tier 1 Low and Tier 2 are not shown (checked early
 *               too, so those ISQs aren't sent to the pairing call)
 *   check    8. every rule above is verified on the result; a failure is a warning
 */

/** An ISQ is thin with this many High values or fewer. */
export const THIN_HIGH = 1;
/** A thin ISQ is topped up to this many High / Medium values, with at most MAX_ADDED new ones. */
export const THIN_TARGET = 4;
export const MAX_ADDED = 3;
/** With this many High values, the Medium ones are not shown. */
export const HIGH_ONLY_AT = 4;
/** With this many Tier 1 High / Medium ISQs, Tier 1 Low and Tier 2 ISQs are not shown. */
export const STRONG_TIER1 = 3;
/** A measurement ISQ with fewer good values than this takes the category document's instead. */
export const MIN_GOOD_MEASURES = 3;
/** An ISQ needs this many values to be shown at all. */
export const MIN_VALUES = 2;

const PRICE_NAME = /\b(price|budget|cost)\b/i;
const PLACE_NAME = /\b(city|location|near ?me)\b/i;
/** Price and seller location are never ISQs here. */
export const isExcludedIsq = (name: string) => PRICE_NAME.test(name) || PLACE_NAME.test(name);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const isOther = (v: string) => /^other\b/i.test(v.trim());
/** Not a value a buyer could pick: catch-alls and "ask us" answers sellers type into a spec. */
const JUNK =
  /^(others?|all( types?)?|any( types?)?|etc\.?|n\.?a\.?|n\/a|none|nil|not applicable|various|multiple|custom(i[sz]ed?)?|customer|costomer|as (per|par)\b.*|on (request|demand)|available)$/i;
const isJunk = (v: string) => isOther(v) || JUNK.test(v.trim().replace(/\s+/g, " "));
const round1 = (n: number) => Math.round(n * 10) / 10;
const LEVEL_RANK: Record<ValueLevel, number> = { High: 0, Medium: 1, Low: 2 };
const levelOf = (share: number): ValueLevel =>
  share >= HIGH_AT ? "High" : share >= MEDIUM_AT ? "Medium" : "Low";
const lift = (l: ValueLevel): ValueLevel => (l === "Low" ? "Medium" : "High");

// ───────────────────────────── text values: one key per meaning ─────────────────────────────

const SPELLING: [RegExp, string][] = [
  [/\baluminum\b/g, "aluminium"],
  [/\bfiber/g, "fibre"],
  [/\bgalvanised\b/g, "galvanized"],
  [/\bcolour/g, "color"],
  [/\bgrey\b/g, "gray"],
  [/\bmoulded\b/g, "molded"],
  [/\bpre[\s-]*fab(ricated)?\b/g, "prefabricated"],
  [/\bpuff\b/g, "puf"],
  [/\bwooden\b/g, "wood"],
  [/\brectangle\b/g, "rectangular"],
];
/** The value is already written the standard way (none of the respellings above applies to it). */
const standardSpelling = (label: string) => {
  const l = label.toLowerCase();
  return SPELLING.every(([re, to]) => l.replace(re, to) === l);
};
/** Short forms and what they stand for, so "MS", "Mild Steel" and "MS (Mild Steel)" are one value. */
const SHORT_FORMS: Record<string, string[]> = {
  ms: ["mild", "steel"],
  gi: ["galvanized", "iron"],
  ss: ["stainless", "steel"],
  frp: ["fibre", "reinforced", "plastic"],
  puf: ["polyurethane", "foam"],
  acp: ["aluminium", "composite", "panel"],
  eps: ["expanded", "polystyrene"],
  hdpe: ["high", "density", "polyethylene"],
  peb: ["pre", "engineered", "building"],
  lgsf: ["light", "gauge", "steel", "frame"],
};
const stem = (t: string) =>
  t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;

/** The words of a value with spellings unified, short forms written out, plurals dropped and repeats removed. */
export function valueTokens(value: string): string[] {
  let s = value.toLowerCase();
  for (const [re, to] of SPELLING) s = s.replace(re, to);
  const out: string[] = [];
  for (const raw of s.split(/[^a-z0-9.]+/).filter((t) => t && t !== "etc"))
    for (const t of SHORT_FORMS[raw] ?? [stem(raw)]) if (!out.includes(t)) out.push(t);
  return out;
}

/** A text value as shown: spaces and a trailing full stop tidied, and an all-lowercase one capitalised. */
function tidy(label: string): string {
  const t = label
    .replace(/\s+/g, " ")
    .replace(/\s*[.,;]+$/, "")
    .replace(/\s+etc$/i, "")
    .trim();
  return /[A-Z]/.test(t) ? t : t.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Two text values with the same key are the same value ("Green House" = "Greenhouse", "Steels" = "Steel"). */
export const valueKey = (value: string) => valueTokens(value).join("");

const JOINERS = new Set(["with", "and", "cum", "plus", "or"]);

/**
 * `a` is the generic form of `b`: all of a's words stand together inside b ("Steel" in "Mild Steel", "Wood" in
 * "Pine Wood"). A combination ("MS With GI", "FRP And PVC", "GI / MS Sheet") is not a kind of its parts.
 */
export function isGenericOf(a: string, b: string): boolean {
  const ta = valueTokens(a);
  const tb = valueTokens(b);
  if (!ta.length || ta.length >= tb.length) return false;
  if (/[/+&,]/.test(b) || tb.some((t) => JOINERS.has(t))) return false;
  for (let i = 0; i + ta.length <= tb.length; i++)
    if (ta.every((t, j) => tb[i + j] === t)) return true;
  return false;
}

// ───────────────────────────── ISQ names: one key per attribute ─────────────────────────────

const NAME_SYNONYMS: Record<string, string> = {
  usage: "use",
  application: "use",
  purpose: "use",
  enduse: "use",
  dimension: "size",
};
const NAME_FILLER = new Set(["type", "kind", "of", "the", "and", "end", "category", "for"]);

function nameTokens(name: string): string[] {
  const out: string[] = [];
  for (const raw of name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    const s = stem(raw);
    const t = NAME_SYNONYMS[s] ?? s;
    if (!NAME_FILLER.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

// ───────────────────────────── evidence: what the data says about a value ─────────────────────────────

interface Group {
  /** Share (%) of the keyword dimension's demand, per source, summed over the spellings in the group. */
  demand: Record<string, number>;
  listings: number;
}

interface Sources {
  /** Every raw spelling in the keyword dimension and the listing spec, with its numbers. */
  raws: { label: string; demand: Record<string, number>; listings: number }[];
  filled: number;
  dim: string | null;
  spec: string | null;
}

function sourcesOf(f: FilterRow, ev: Pick<Evidence, "aggregation" | "listing">): Sources {
  const dim = f.linked_dimension
    ? ev.aggregation?.dimensions.find((d) => norm(d.name) === norm(f.linked_dimension!))
    : undefined;
  const spec = f.linked_listing_spec
    ? ev.listing?.fields.find((x) => norm(x.key) === norm(f.linked_listing_spec!))
    : undefined;
  const raws: Sources["raws"] = [];
  for (const v of dim?.values ?? []) {
    const demand: Record<string, number> = {};
    for (const [src, b] of Object.entries(v.bySource)) if (b) demand[src] = b.share;
    raws.push({ label: v.value, demand, listings: 0 });
  }
  for (const [label, n] of spec?.all ?? spec?.top ?? [])
    raws.push({ label, demand: {}, listings: n });
  return { raws, filled: spec?.filled ?? 0, dim: dim?.name ?? null, spec: spec?.key ?? null };
}

function groupBy(src: Sources, keyOf: (label: string) => string | null): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const r of src.raws) {
    const key = keyOf(r.label);
    if (!key) continue;
    const g = groups.get(key) ?? { demand: {}, listings: 0 };
    for (const [s, share] of Object.entries(r.demand)) g.demand[s] = (g.demand[s] ?? 0) + share;
    g.listings += r.listings;
    groups.set(key, g);
  }
  return groups;
}

type Scored = Omit<ValueConfidence, "value">;

/** The usual rule (skill 09), on a value's whole group: High ≥ 20% of demand or of filled listings, Medium ≥ 5%. */
function score(g: Group | undefined, src: Sources): Scored {
  const demandPct =
    g && Object.keys(g.demand).length
      ? Math.min(100, round1(Math.max(...Object.values(g.demand))))
      : null;
  const fillPct =
    g && g.listings > 0 && src.filled
      ? Math.min(100, round1((g.listings / src.filled) * 100))
      : null;
  const parts: string[] = [];
  if (demandPct !== null) parts.push(`${demandPct}% of the keyword demand for ${src.dim}`);
  if (fillPct !== null)
    parts.push(`${fillPct}% of the listings that fill ${src.spec} (${g!.listings})`);
  if (!parts.length)
    return {
      level: "Low",
      why: "Not seen in the keyword or listing data",
      fill_pct: null,
      listings: 0,
      demand_pct: null,
      source: "data",
    };
  return {
    level: levelOf(Math.max(demandPct ?? 0, fillPct ?? 0)),
    why: parts.join(" · "),
    fill_pct: fillPct,
    listings: g?.listings ?? 0,
    demand_pct: demandPct,
    source: "data",
  };
}

// ───────────────────────────── one ISQ's values ─────────────────────────────

interface Item {
  key: string;
  vc: ValueConfidence;
  /** The filter's own values (as they were) that became this item: what the document pairs are keyed by. */
  origs: string[];
}

interface Work {
  f: FilterRow;
  eligible: boolean;
  measure: MeasureKind | null;
  shape: QuantityShape | null;
  /** The shape came from the category document's ISQ (so its values can replace or add to ours). */
  docShaped: boolean;
  src: Sources;
  groups: Map<string, Group>;
  keyOf: (label: string) => string | null;
  labelOf: (label: string) => string;
  /** Measurements: a value as a quantity of this ISQ's shape, or why it isn't one. */
  fit: ((label: string) => Quantity | string) | null;
  items: Item[];
  pair: DocPair | null;
  /** Set when this ISQ was folded into another one for the same attribute. */
  mergedInto: string | null;
  usedDoc: boolean;
  /** A measurement whose values were taken from the category document: nothing else is added to them. */
  fromDoc: boolean;
  notes: string[];
  warnings: string[];
}

/** Tier 1 at any confidence, Tier 2 only when High; never Price or Location. */
export function isEligible(f: FilterRow): boolean {
  if (isExcludedIsq(f.name)) return false;
  return f.tier === "Tier 1" || (f.tier === "Tier 2" && f.confidence === "High");
}

const sorted = (items: Item[]) =>
  [...items].sort(
    (a, b) =>
      LEVEL_RANK[a.vc.level] - LEVEL_RANK[b.vc.level] ||
      (b.vc.fill_pct ?? -1) - (a.vc.fill_pct ?? -1) ||
      (b.vc.demand_pct ?? -1) - (a.vc.demand_pct ?? -1),
  );

function buildWork(
  f: FilterRow,
  ev: Pick<Evidence, "aggregation" | "listing">,
  pair: DocPair | null,
): Work {
  const src = sourcesOf(f, ev);
  const base = f.values.map((v) => v.trim()).filter((v) => v && !isJunk(v));
  const w: Work = {
    f,
    eligible: isEligible(f),
    measure: null,
    shape: null,
    docShaped: false,
    src,
    groups: new Map(),
    keyOf: (label) => valueKey(label) || null,
    labelOf: tidy,
    fit: null,
    items: [],
    pair,
    mergedInto: null,
    usedDoc: false,
    fromDoc: false,
    notes: [],
    warnings: [],
  };

  // 1 · a measurement ISQ: its name says so, and enough of its values really are quantities.
  const measure = measureKind(f.name);
  const parsed = base.map((v) => parseQuantity(v));
  const quantities = (labels: string[], weight: (label: string) => number) =>
    labels.flatMap((label) => {
      const q = parseQuantity(label);
      return q ? [{ q, weight: weight(label) }] : [];
    });
  const docShape =
    measure && pair
      ? dominantShape(
          quantities(pair.isq.values, () => 1),
          measure,
        )
      : null;
  // The category document's ISQ makes it a measurement whatever our own values look like.
  if (
    measure &&
    (docShape || (base.length && parsed.filter(Boolean).length / base.length >= 0.3))
  ) {
    if (pair && !docShape) {
      w.notes.push(
        `"${f.name}": the category document's "${pair.isq.name}" doesn't hold ${measure === "area" ? "areas" : measure === "length" ? "lengths" : "sizes"}, so it wasn't used.`,
      );
      w.pair = null;
    }
    const weightOf = new Map<string, number>();
    for (const r of src.raws) {
      const share = Math.max(
        0,
        ...Object.values(r.demand),
        src.filled ? (r.listings / src.filled) * 100 : 0,
      );
      weightOf.set(r.label, Math.max(weightOf.get(r.label) ?? 0, share));
    }
    const ownShape = dominantShape(
      quantities(
        [...new Set([...base, ...src.raws.map((r) => r.label)])],
        (l) => 1 + (weightOf.get(l) ?? 0),
      ),
      measure,
    );
    const shape = docShape ?? ownShape;
    if (shape) {
      w.measure = measure;
      w.shape = shape;
      w.docShaped = Boolean(docShape);
      const axis = axisOf(f.name);
      const fit = (label: string): Quantity | string => {
        const q = parseQuantity(label);
        return q ? conform(q, shape, axis) : "not a number with a unit";
      };
      w.fit = fit;
      w.keyOf = (label) => {
        const q = fit(label);
        return typeof q === "string" ? null : quantityKey(q);
      };
      w.labelOf = (label) => {
        const q = fit(label);
        return typeof q === "string" ? label : formatQuantity(q);
      };
      const dropped = base.flatMap((v) => {
        const q = fit(v);
        return typeof q === "string" ? [`${v} (${q})`] : [];
      });
      if (dropped.length)
        w.notes.push(
          `"${f.name}": left out ${dropped.join(", ")}; its values are ${shape.kind === "dims" ? `${shape.axes} numbers (${shape.axes === 2 ? "length x width" : "length x width x height"})` : `one number (${shape.kind === "area" ? "an area" : "a length"})`} in ${shape.unit}${docShape ? `, as in the category document's "${pair!.isq.name}"` : ""}.`,
        );
    }
  }

  // 2 · one item per meaning, scored on everything the data holds under any of its spellings.
  w.groups = groupBy(src, w.keyOf);
  const merged: string[] = [];
  for (const v of base) {
    const key = w.keyOf(v);
    if (!key) continue;
    const seen = w.items.find((it) => it.key === key);
    if (seen) {
      seen.origs.push(v);
      if (w.labelOf(v) !== seen.vc.value || !w.measure) merged.push(`${v} = ${seen.vc.value}`);
      continue;
    }
    w.items.push({
      key,
      origs: [v],
      vc: { value: w.labelOf(v), ...score(w.groups.get(key), src) },
    });
  }
  if (merged.length) w.notes.push(`"${f.name}": merged duplicates (${merged.join("; ")}).`);
  // Of the spellings that became one text value, show the one the data uses most; on a tie, the standard one
  // ("PUF" rather than "Puff").
  if (!w.measure) {
    const used = (label: string) =>
      src.raws
        .filter((r) => r.label.toLowerCase() === label.toLowerCase())
        .reduce((n, r) => n + r.listings + Math.max(0, ...Object.values(r.demand)), 0);
    for (const it of w.items) {
      if (it.origs.length < 2) continue;
      const best = [...it.origs].sort(
        (a, b) => used(b) - used(a) || Number(standardSpelling(b)) - Number(standardSpelling(a)),
      )[0]!;
      it.vc.value = tidy(best);
    }
  }

  // 3 · a measurement ISQ takes its values straight from the category document whenever the document has the
  // same measurement: the document's values, as written there (one spelling only), nothing of our own added.
  // The data only says how strong each one is. Without a matching document ISQ, ours stay, cleaned.
  const isRange = (it: Item) => {
    const q = w.fit?.(it.vc.value);
    return typeof q === "object" && q.range !== "";
  };
  const few = w.items.length < MIN_GOOD_MEASURES;
  const mixed = w.items.some(isRange) && !w.items.every(isRange);
  const why = few
    ? `only ${w.items.length} good value(s) in the data (${w.items.map((it) => it.vc.value).join(", ") || "none"})`
    : f.needs_new_isq
      ? "the model flagged it as needing work"
      : mixed
        ? `its values mix exact numbers and ranges (${w.items.map((it) => it.vc.value).join(", ")})`
        : "";
  if (w.measure && w.docShaped && w.pair && w.eligible) {
    const fromDoc: Item[] = [];
    for (const v of w.pair.isq.values) {
      const key = w.keyOf(v);
      if (!key || fromDoc.some((it) => it.key === key)) continue;
      const own = w.items.find((it) => it.key === key);
      fromDoc.push({ key, origs: own?.origs ?? [], vc: docValue(w, w.labelOf(v), key) });
    }
    if (fromDoc.length >= MIN_VALUES) {
      const ours = w.items.map((it) => it.vc.value);
      w.notes.push(
        `"${f.name}": values taken from the category document's "${w.pair.isq.name}" (${fromDoc.map((it) => it.vc.value).join(", ")})${ours.length ? `; the data had ${ours.join(", ")}` : ""}.`,
      );
      w.items = fromDoc;
      w.usedDoc = true;
      w.fromDoc = true;
    }
  } else if (w.measure && (few || mixed) && w.eligible) {
    w.warnings.push(
      `"${f.name}": ${why}, and the category document has no matching ISQ to take values from.`,
    );
  }

  dropGenerics(w);
  return w;
}

/**
 * A value taken from the category document: the level the data gives it (a range is scored on the exact values
 * inside it), and Medium at the least, so a value the data doesn't hold is still shown.
 */
function docValue(w: Work, value: string, key: string): ValueConfidence {
  const s = score(inRange(w, value) ?? w.groups.get(key), w.src);
  return {
    value,
    ...s,
    level: s.level === "Low" ? "Medium" : s.level,
    why: `${s.level === "Low" && s.listings === 0 && s.demand_pct === null ? "" : `${s.why} · `}from the category document's ${w.pair!.isq.name}`,
    source: "doc",
  };
}

/**
 * A range ("401 - 600 sq ft", "Above 1000 sq ft"): everything the data holds as an exact value inside it, so the
 * range is scored on the listings and searches it really covers. undefined for a value that isn't a range.
 */
function inRange(w: Work, value: string): Group | undefined {
  const q = w.fit?.(value);
  if (typeof q !== "object" || !q.range || q.kind === "dims") return undefined;
  const [a, b] = q.nums as [number, number | undefined];
  const inside = (n: number) =>
    q.range === "upto" ? n <= a : q.range === "above" ? n > a : n >= a && n <= (b ?? a);
  const g: Group = { demand: {}, listings: 0 };
  for (const r of w.src.raws) {
    const rq = w.fit!(r.label);
    if (typeof rq !== "object" || rq.kind === "dims") continue;
    // The same range written in the data, or an exact value inside it.
    const same = rq.range !== "" && quantityKey(rq) === quantityKey(q);
    if (!same && (rq.range !== "" || !inside(rq.nums[0]!))) continue;
    for (const [src, share] of Object.entries(r.demand))
      g.demand[src] = (g.demand[src] ?? 0) + share;
    g.listings += r.listings;
  }
  return g;
}

const shareOf = (it: Item) => Math.max(it.vc.fill_pct ?? 0, it.vc.demand_pct ?? 0);

/** `drop` is the same value as `keep`: its numbers are added to keep's, and the level is worked out again. */
function absorb(w: Work, keep: Item, drop: Item) {
  const listings = (keep.vc.listings ?? 0) + (drop.vc.listings ?? 0);
  const fill =
    listings && w.src.filled ? Math.min(100, round1((listings / w.src.filled) * 100)) : null;
  const demand =
    keep.vc.demand_pct == null && drop.vc.demand_pct == null
      ? null
      : Math.min(100, round1((keep.vc.demand_pct ?? 0) + (drop.vc.demand_pct ?? 0)));
  const level = [levelOf(Math.max(fill ?? 0, demand ?? 0)), keep.vc.level, drop.vc.level].sort(
    (a, b) => LEVEL_RANK[a] - LEVEL_RANK[b],
  )[0]!;
  keep.vc = {
    ...keep.vc,
    level,
    fill_pct: fill,
    listings,
    demand_pct: demand,
    why: `${keep.vc.why} · counted with "${drop.vc.value}"`,
  };
  keep.origs.push(...drop.origs);
}

/**
 * Text ISQs: a generic value beside a specific one is a duplicate. With one specific ("Office" beside "Portable
 * Office") the two are one value: the stronger spelling stays (the specific one on a tie) and their numbers are
 * added. With several ("Wood" beside "Pine Wood" and "Teak Wood") the specifics are the real options, so the
 * generic goes.
 */
function dropGenerics(w: Work) {
  if (w.measure) return;
  const done: string[] = [];
  for (let again = true; again;) {
    again = false;
    for (const a of w.items) {
      const specifics = w.items.filter((b) => b !== a && isGenericOf(a.vc.value, b.vc.value));
      if (!specifics.length) continue;
      if (specifics.length >= 2) {
        w.items = w.items.filter((x) => x !== a);
        done.push(
          `${a.vc.value} dropped (${specifics.map((b) => b.vc.value).join(", ")} are the specific ones)`,
        );
      } else {
        const b = specifics[0]!;
        const [keep, drop] = shareOf(a) > shareOf(b) ? [a, b] : [b, a];
        absorb(w, keep, drop);
        w.items = w.items.filter((x) => x !== drop);
        done.push(`${drop.vc.value} counted as ${keep.vc.value}`);
      }
      again = true;
      break;
    }
  }
  if (done.length)
    w.notes.push(`"${w.f.name}": generic and specific duplicates: ${done.join("; ")}.`);
}

const strong = (w: Work) => w.items.filter((it) => it.vc.level !== "Low");
const highs = (w: Work) => w.items.filter((it) => it.vc.level === "High");

/** Is this ISQ thin (so the category document may be used on it)? */
const isThin = (w: Work) => highs(w).length <= THIN_HIGH;

/** 3 · thin ISQ: listing values the keywords missed, then the category document (lift, then add). */
function boost(w: Work) {
  if (!w.eligible || w.mergedInto || w.fromDoc || !isThin(w)) return;
  const lifted: string[] = [];
  const pair = w.pair && (!w.measure || w.docShaped) ? w.pair : null;

  if (pair) {
    const docKeys = new Map<string, string>();
    for (const v of pair.isq.values) {
      const key = w.keyOf(v);
      if (key && !docKeys.has(key)) docKeys.set(key, w.labelOf(v));
    }
    for (const it of w.items) {
      if (it.vc.level === "High" || it.vc.source === "doc") continue;
      const paired = it.origs.map((o) => pair.values.get(o)).find(Boolean);
      const docLabel = docKeys.get(it.key) ?? (paired ? w.labelOf(paired) : undefined);
      if (!docLabel) continue;
      const to = lift(it.vc.level);
      lifted.push(
        `${it.vc.value}${docLabel !== it.vc.value ? ` → ${docLabel}` : ""} (${it.vc.level} → ${to})`,
      );
      it.vc = {
        ...it.vc,
        value: docLabel,
        level: to,
        why: `${it.vc.why} · listed in the category document's ${pair.isq.name}`,
        lifted: true,
      };
      w.usedDoc = true;
    }
  }

  let room = Math.min(MAX_ADDED, Math.max(0, THIN_TARGET - strong(w).length));
  const added: string[] = [];
  const fits = (label: string, key: string) =>
    !w.items.some(
      (it) =>
        it.key === key ||
        (!w.measure && (isGenericOf(label, it.vc.value) || isGenericOf(it.vc.value, label))),
    );

  // Real data first: what sellers fill that the keywords didn't name, when it is at least Medium.
  if (room > 0) {
    const fromListings: Item[] = [];
    for (const r of w.src.raws) {
      if (r.listings <= 0) continue;
      const key = w.keyOf(r.label);
      if (!key || isJunk(r.label) || fromListings.some((it) => it.key === key)) continue;
      const s = score(w.groups.get(key), w.src);
      if (s.level === "Low") continue;
      fromListings.push({
        key,
        origs: [],
        vc: { value: w.labelOf(r.label), ...s, source: "listing" },
      });
    }
    for (const it of sorted(fromListings)) {
      if (room <= 0) break;
      if (!fits(it.vc.value, it.key)) continue;
      w.items.push(it);
      added.push(`${it.vc.value} (${it.vc.level}, on listings)`);
      room--;
    }
  }
  if (room > 0 && pair) {
    for (const v of pair.isq.values) {
      if (room <= 0) break;
      const key = w.keyOf(v);
      const label = w.labelOf(v);
      // A document value already paired with one of ours is that value, not a new one.
      if (!key || !fits(label, key) || [...pair.values.values()].includes(v)) continue;
      const vc = docValue(w, label, key);
      w.items.push({ key, origs: [], vc });
      added.push(`${label} (${vc.level}, category document)`);
      w.usedDoc = true;
      room--;
    }
  }
  if (lifted.length)
    w.notes.push(`"${w.f.name}" was thin: the category document confirmed ${lifted.join(", ")}.`);
  if (added.length) w.notes.push(`"${w.f.name}" was thin: added ${added.join(", ")}.`);
}

/**
 * Numeric values are listed smallest first: a measurement by its numbers ("4 x 4 ft" before "4 x 6 ft" before
 * "10 x 10 ft"; a range by where it starts, "Up to …" first and "Above …" last), and text values that all begin
 * with a number ("2 Seater", "10 Seater", "1 BHK") by that number. Other values keep the order given (best first).
 */
function inOrder(w: Work, items: Item[]): Item[] {
  const byNumbers = (keyed: { it: Item; at: number[] }[]) =>
    keyed
      .map((k, i) => ({ ...k, i }))
      .sort((a, b) => {
        for (let j = 0; j < Math.max(a.at.length, b.at.length); j++) {
          // A value with fewer numbers that is otherwise equal comes first ("500" before "500 - 1000").
          const d = (a.at[j] ?? -Infinity) - (b.at[j] ?? -Infinity);
          if (d) return d;
        }
        return a.i - b.i;
      })
      .map((k) => k.it);
  if (w.fit) {
    const keyed: { it: Item; at: number[] }[] = [];
    for (const it of items) {
      const q = w.fit(it.vc.value);
      if (typeof q !== "object") break;
      keyed.push({
        it,
        at:
          q.range === "upto"
            ? [-1, q.nums[0]!]
            : q.range === "above"
              ? [q.nums[0]!, Infinity]
              : q.nums,
      });
    }
    if (keyed.length === items.length) return byNumbers(keyed);
  }
  const lead = items.map((it) => it.vc.value.match(/^\s*(\d+(?:\.\d+)?)/)?.[1]);
  if (items.length > 1 && lead.every((n) => n !== undefined))
    return byNumbers(items.map((it, i) => ({ it, at: [Number(lead[i])] })));
  return items;
}

/**
 * 4 · the values shown: High and Medium (with HIGH_ONLY_AT or more High, only those), best first, or smallest
 * first when they are numbers.
 */
function shown(w: Work): Item[] {
  const high = highs(w);
  return inOrder(w, sorted(high.length >= HIGH_ONLY_AT ? high : strong(w)));
}

// ───────────────────────────── the MCAT's ISQs ─────────────────────────────

const TIER_RANK: Record<string, number> = { "Tier 1": 0, "Tier 2": 1, "Tier 3": 2 };

/** Better ISQ first: tier, confidence, the model's rank, and last of all the place in the spec ranking (input 4). */
function better(a: Work, b: Work, ranking: string[]): number {
  const place = (w: Work) => {
    const i = ranking.findIndex((n) => norm(n) === norm(w.f.name));
    return i === -1 ? ranking.length : i;
  };
  return (
    (TIER_RANK[a.f.tier] ?? 9) - (TIER_RANK[b.f.tier] ?? 9) ||
    LEVEL_RANK[a.f.confidence] - LEVEL_RANK[b.f.confidence] ||
    a.f.rank - b.f.rank ||
    place(a) - place(b)
  );
}

/** Two ISQs hold one attribute: the same name words, or one name inside the other with values in common. */
function sameAttribute(a: Work, b: Work): boolean {
  if (Boolean(a.measure) !== Boolean(b.measure)) return false;
  const ta = nameTokens(a.f.name);
  const tb = nameTokens(b.f.name);
  if (!ta.length || !tb.length) return false;
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (!small.every((t) => large.includes(t))) return false;
  if (small.length === large.length) return true;
  const keys = new Set(a.items.map((it) => it.key));
  const shared = b.items.filter((it) => keys.has(it.key)).length;
  return shared >= 2 || shared >= Math.min(a.items.length, b.items.length) / 2;
}

export interface SelectReport {
  /** ISQs shown, of how many. */
  selected: number;
  total: number;
  /** What was changed, in plain words (shown in the step's working). */
  notes: string[];
  /** Things a reviewer should look at. */
  warnings: string[];
  /** Rules that did not hold on the result (should be empty). */
  failed: string[];
  /** ISQs that used the category document. */
  usedDoc: number;
}

/**
 * The eligible ISQs the category document is needed for: measurements (it says their unit and shape) and thin
 * ones (it may add to them). Only these are sent to the pairing call.
 */
export function isqsNeedingDoc(
  filters: FilterRow[],
  ev: Pick<Evidence, "aggregation" | "listing">,
): FilterRow[] {
  const works = filters.filter(isEligible).map((f) => buildWork(f, ev, null));
  // The tier rule, applied early to save the work: with STRONG_TIER1 Tier 1 High / Medium ISQs that already have
  // their values, Tier 1 Low and Tier 2 ISQs won't be shown, so they aren't sent for pairing either.
  const isStrong = (w: Work) => w.f.tier === "Tier 1" && w.f.confidence !== "Low";
  const settled = works.filter((w) => isStrong(w) && shown(w).length >= MIN_VALUES).length;
  return works
    .filter((w) => settled < STRONG_TIER1 || isStrong(w))
    .filter((w) => Boolean(measureKind(w.f.name)) || isThin(w))
    .map((w) => w.f);
}

/**
 * Applies the rules in the header comment to an MCAT's filters, in place: `values` and `value_confidence`
 * become the cleaned, de-duplicated set (all levels, best first), `selected_values` the ones shown, and
 * `selected` / `select_note` say whether the ISQ is shown and why not.
 */
export function selectIsqs(
  filters: FilterRow[],
  ev: Pick<Evidence, "aggregation" | "listing">,
  pairs: DocPair[],
  ranking: string[] = [],
): SelectReport {
  const pairOf = new Map(pairs.map((p) => [p.filter, p]));
  const works = filters.map((f) =>
    buildWork(f, ev, isEligible(f) ? (pairOf.get(f) ?? null) : null),
  );
  const notes: string[] = [];
  const warnings: string[] = [];

  // 6 · two ISQs for one attribute are one: the better keeps the other's values.
  const live = works.filter((w) => w.eligible).sort((a, b) => better(a, b, ranking));
  for (let i = 0; i < live.length; i++) {
    const keep = live[i]!;
    if (keep.mergedInto) continue;
    for (const other of live.slice(i + 1)) {
      if (other.mergedInto || !sameAttribute(keep, other)) continue;
      other.mergedInto = keep.f.name;
      const taken: string[] = [];
      for (const it of other.items) {
        const key = keep.keyOf(it.vc.value);
        if (!key || keep.items.some((x) => x.key === key)) continue;
        keep.items.push({ ...it, key });
        taken.push(it.vc.value);
      }
      dropGenerics(keep);
      notes.push(
        `"${other.f.name}" is the same attribute as "${keep.f.name}": merged into it${taken.length ? ` (brought ${taken.join(", ")})` : ""}.`,
      );
    }
  }

  for (const w of works) boost(w);

  // A value shown under two ISQs stays under the one where it is stronger (text values only).
  const shownOf = new Map(works.map((w) => [w, shown(w)]));
  const text = live.filter((w) => !w.mergedInto && !w.measure);
  for (let i = 0; i < text.length; i++)
    for (const other of text.slice(i + 1)) {
      const a = text[i]!;
      for (const it of [...shownOf.get(a)!]) {
        const twin = shownOf.get(other)!.find((x) => x.key === it.key);
        if (!twin) continue;
        const share = (x: Item) => Math.max(x.vc.fill_pct ?? 0, x.vc.demand_pct ?? 0);
        const loser = share(twin) > share(it) ? a : other;
        shownOf.set(
          loser,
          shownOf.get(loser)!.filter((x) => x.key !== it.key),
        );
        loser.items = loser.items.filter((x) => x.key !== it.key);
        notes.push(
          `${it.vc.value} was under both "${a.f.name}" and "${other.f.name}": kept under "${loser === a ? other.f.name : a.f.name}".`,
        );
      }
    }

  // 5–7 · which ISQs are shown.
  const reason = new Map<Work, string>();
  for (const w of works) {
    const f = w.f;
    if (isExcludedIsq(f.name)) reason.set(w, "Price and location are not ISQs");
    else if (f.tier === "Tier 3")
      reason.set(w, "Tier 3 (shown on the listing card, not as an ISQ)");
    else if (f.tier === "Tier 2" && f.confidence !== "High")
      reason.set(w, `Tier 2 with ${f.confidence} confidence (only High is picked from Tier 2)`);
    else if (w.mergedInto) reason.set(w, `Same attribute as "${w.mergedInto}"`);
    else if (shownOf.get(w)!.length < MIN_VALUES)
      reason.set(
        w,
        `Only ${shownOf.get(w)!.length} High / Medium value(s) (an ISQ needs ${MIN_VALUES})`,
      );
  }
  const candidates = works.filter((w) => !reason.has(w));
  const tier1Strong = candidates.filter((w) => w.f.tier === "Tier 1" && w.f.confidence !== "Low");
  if (tier1Strong.length >= STRONG_TIER1)
    for (const w of candidates)
      if (!tier1Strong.includes(w))
        reason.set(
          w,
          `${tier1Strong.length} Tier 1 High / Medium ISQs are shown, so ${w.f.tier === "Tier 1" ? "Tier 1 Low" : "Tier 2"} is not`,
        );

  // Write the result back onto the filters.
  for (const w of works) {
    const f = w.f;
    const all = inOrder(w, sorted(w.items));
    f.values = all.map((it) => it.vc.value);
    if (all.length) f.value_confidence = all.map((it) => it.vc);
    else delete f.value_confidence;
    f.selected_values = shownOf.get(w)!.map((it) => it.vc.value);
    f.selected = !reason.has(w);
    if (reason.has(w)) f.select_note = reason.get(w)!;
    else delete f.select_note;
    if (w.usedDoc && w.pair) f.doc_isq = w.pair.isq.name;
    else delete f.doc_isq;
    if (w.shape) f.unit = w.shape.unit;
    // AI-suggested values are no longer used: what the data lacks comes from the category document.
    delete f.ai_values;
    notes.push(...w.notes);
    if (f.selected) warnings.push(...w.warnings);
  }

  const failed = checkSelection(filters);
  return {
    selected: filters.filter((f) => f.selected).length,
    total: filters.length,
    notes,
    warnings,
    failed,
    usedDoc: works.filter((w) => w.usedDoc && w.f.selected).length,
  };
}

/**
 * 8 · the check: every rule, verified on the finished filters. Returns one line per rule that doesn't hold
 * (none when all is well), so a slip in the steps above can't pass silently.
 */
export function checkSelection(filters: FilterRow[]): string[] {
  const failed: string[] = [];
  const picked = filters.filter((f) => f.selected);
  const tier1Strong = picked.filter((f) => f.tier === "Tier 1" && f.confidence !== "Low");

  for (const f of picked) {
    const name = `"${f.name}"`;
    const values = f.selected_values ?? [];
    const level = new Map((f.value_confidence ?? []).map((c) => [c.value, c.level]));
    if (isExcludedIsq(f.name)) failed.push(`${name} is a price or location ISQ but is shown.`);
    if (f.tier === "Tier 3") failed.push(`${name} is Tier 3 but is shown.`);
    if (f.tier === "Tier 2" && f.confidence !== "High")
      failed.push(`${name} is Tier 2 with ${f.confidence} confidence but is shown.`);
    if (tier1Strong.length >= STRONG_TIER1 && !tier1Strong.includes(f))
      failed.push(`${name} is shown although ${tier1Strong.length} Tier 1 High / Medium ISQs are.`);
    if (values.length < MIN_VALUES) failed.push(`${name} is shown with ${values.length} value(s).`);

    const weak = values.filter((v) => level.get(v) !== "High" && level.get(v) !== "Medium");
    if (weak.length)
      failed.push(`${name} shows values that aren't High or Medium: ${weak.join(", ")}.`);
    const high = values.filter((v) => level.get(v) === "High").length;
    if (high >= HIGH_ONLY_AT && high < values.length)
      failed.push(`${name} has ${high} High values but still shows Medium ones.`);

    // Measurements: every value a quantity, all of one kind, one unit and the same count of numbers; a
    // Length, Width or Height is always one number.
    if (measureKind(f.name) && f.unit) {
      const shapes = new Set<string>();
      for (const v of values) {
        const q = parseQuantity(v);
        if (!q) failed.push(`${name}: "${v}" is not a number with a unit.`);
        else {
          shapes.add(`${q.kind}|${q.unit}|${q.kind === "dims" ? q.nums.length : 1}`);
          if (measureKind(f.name) === "length" && q.kind === "dims")
            failed.push(`${name}: "${v}" has ${q.nums.length} numbers, but this ISQ takes one.`);
        }
      }
      if (shapes.size > 1)
        failed.push(`${name} mixes units or kinds of measurement: ${values.join(", ")}.`);
    }

    // No duplicates: the same value twice, or (text) a generic beside its specific.
    const measured = Boolean(measureKind(f.name) && f.unit);
    const keys = values.map((v) => {
      const q = measured ? parseQuantity(v) : null;
      return q ? quantityKey(q) : valueKey(v);
    });
    const twice = values.filter((_, i) => keys.indexOf(keys[i]!) !== i);
    if (twice.length) failed.push(`${name} shows a value twice: ${twice.join(", ")}.`);
    if (!measured)
      for (const a of values)
        for (const b of values)
          if (a !== b && isGenericOf(a, b))
            failed.push(`${name} shows "${a}" beside the more specific "${b}".`);
  }

  // No value under two text ISQs.
  const seen = new Map<string, string>();
  for (const f of picked) {
    if (measureKind(f.name) && f.unit) continue;
    for (const v of f.selected_values ?? []) {
      const k = valueKey(v);
      if (seen.has(k) && seen.get(k) !== f.name)
        failed.push(`"${v}" is shown under both "${seen.get(k)}" and "${f.name}".`);
      seen.set(k, f.name);
    }
  }
  return [...new Set(failed)];
}
