import type { Evidence, FilterRow } from "./filter-gen";
import type { DocMcat, DocPair } from "./category-doc";
import {
  axisOf,
  conform,
  COUNT_NOUN,
  countedInBrackets,
  countsFor,
  dominantShape,
  figuresIn,
  formatQuantity,
  isSpatial,
  KIND_PLURAL,
  kindName,
  MEASURE_PLURAL,
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
 *   values   1. measurements (Area, Size, Length, Width, Height…, and machine figures: Capacity, Output, Power,
 *               Weight, Volume in kg/hr, L, kW…) get one spelling, one unit and one count of
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
 *            6. the tier is the only test (not how many values); two ISQs for one attribute are both shown
 *            7. every Tier 1 ISQ (High, Medium or Low) and every Tier 2 High one is shown; no cap on how many
 *   check    8. every rule above is verified on the result; a failure is a warning
 */

/** An ISQ is thin with this many High values or fewer. */
export const THIN_HIGH = 1;
/** A thin ISQ is topped up to this many High / Medium values, with at most MAX_ADDED new ones. */
export const THIN_TARGET = 4;
export const MAX_ADDED = 3;
/** With this many High values, the Medium ones are not shown. */
export const HIGH_ONLY_AT = 4;
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
  /^(others?|all( types?)?|any( types?)?|etc\.?|n\.?a\.?|n\/a|none|nil|not applicable|various|multiple|custom(i[sz]ed?)?|customer|costomer|as ?(per|par)\b.*|on (request|demand)|available|text)$/i;
/** Not one option but a choice or a span of them: "Large or Small", "Both Thick or Thin". */
const VAGUE = /\bor\b|^both\b/i;
const isJunk = (v: string) =>
  isOther(v) || JUNK.test(v.trim().replace(/\s+/g, " ")) || VAGUE.test(v.trim());
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
  [/\bflavour/g, "flavor"],
  [/\bautomated\b/g, "automatic"],
  [/\bauto\b/g, "automatic"],
  [/\b(hours?|hrs?)\b/g, "hr"],
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
  // "SS304" is "SS 304": a short form or word run into its number.
  let s = value
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z]{2,})/g, "$1 $2");
  for (const [re, to] of SPELLING) s = s.replace(re, to);
  const out: string[] = [];
  for (const raw of s.split(/[^a-z0-9.]+/).filter((t) => t && t !== "etc"))
    for (const t of SHORT_FORMS[raw] ?? [stem(raw)]) if (!out.includes(t)) out.push(t);
  return out;
}

/** A text value as shown: spaces and a trailing full stop tidied, and an all-lowercase one capitalised. */
/** Words written small in a value: joining words and units ("Kg", "Hr" would look wrong). */
const SMALL_WORDS =
  /^(and|or|of|for|with|to|in|on|per|x|kg|kgs|gm|gms|ltr|ltrs|lit|ml|mm|cm|ft|hr|hrs|min|lph|lpd|tph|tpd|rpm|psi|bar|inch)$/i;

/**
 * One way of writing a value: spaces and trailing punctuation tidied, and each word capitalised the same way —
 * "FULLY AUTOMATED" → "Fully Automated", "Line type" → "Line Type", "Stainless Steel(SS)" → "Stainless Steel (SS)".
 * Short forms stay as written ("SS", "PUF", "HP"), as do joining words and units ("kg/hr").
 */
function tidy(label: string): string {
  const t = label
    .replace(/\s+/g, " ")
    .replace(/(\S)\(/g, "$1 (")
    .replace(/\s*[.,;]+$/, "")
    .replace(/\s+etc$/i, "")
    .trim();
  return t.replace(/[A-Za-z]+/g, (word, at: number) => {
    if (at > 0 && SMALL_WORDS.test(word)) return word.toLowerCase();
    // A long word in capitals is shouting, not a short form ("AUTOMATED"); a short one is a short form ("SS").
    if (word === word.toUpperCase())
      return word.length > 4 ? word[0] + word.slice(1).toLowerCase() : word;
    // Mixed case is deliberate ("kW", "iBake").
    if (/[A-Z]/.test(word.slice(1))) return word;
    return word[0]!.toUpperCase() + word.slice(1);
  });
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
  /** The live ISQ (input 4) whose values this text ISQ took because its own mixed figures with words. */
  fromLive: string | null;
  /** A count ISQ ("Number of Trays"): its values are compared by number, so "10", "10 Tray", "10 trays" are one. */
  count: Count | null;
  notes: string[];
  warnings: string[];
}

/** Tier 1 at any confidence, Tier 2 only when High; never Price or Location. */
export function isEligible(f: FilterRow): boolean {
  if (isExcludedIsq(f.name)) return false;
  return f.tier === "Tier 1" || (f.tier === "Tier 2" && f.confidence === "High");
}

/**
 * Shown as an ISQ: every Tier 1 ISQ (High, Medium or Low) and every Tier 2 High one, and nothing else (never Price
 * or Location). The tier is the only test. The "Shown" tag, the "N ISQs shown" count and the "Selected ISQs (.json)"
 * download all use this, so a result saved under earlier rules reads the same way.
 */
export function isShown(f: FilterRow): boolean {
  return isEligible(f);
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
    fromLive: null,
    count: null,
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
  const counted = parsed.filter((q) => q && countsFor(q, measure ?? "size")).length;
  // The category document's ISQ makes an area, length or size a measurement whatever our own values look like.
  // A machine figure needs at least one number of its own too, so "Output" holding "Single", "Dual" stays text.
  const docMakesIt = Boolean(docShape) && (isSpatial(measure ?? "size") || counted > 0);
  if (measure && (docMakesIt || (base.length && counted / base.length >= 0.3))) {
    if (pair && !docShape) {
      w.notes.push(
        `"${f.name}": the category document's "${pair.isq.name}" doesn't hold ${MEASURE_PLURAL[measure]}, so it wasn't used.`,
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
          `"${f.name}": left out ${dropped.join(", ")}; its values are ${shape.kind === "dims" ? `${shape.axes} numbers (${shape.axes === 2 ? "length x width" : "length x width x height"})` : `one number (${kindName(shape.kind)})`} in ${shape.unit}${docShape ? `, as in the category document's "${pair!.isq.name}"` : ""}.`,
        );
    }
  }

  // A count ISQ compares its values by number and writes them one way: "10", "10 Tray", "10 trays" are "10 Trays";
  // "Single Flavour" is "1 Flavor". A sum ("2+1 Flavour") and anything that isn't a count keep their own key.
  if (!w.measure) {
    const count = countOf(f.name, [...base, ...src.raws.map((r) => r.label)]);
    if (count) applyCount(w, count);
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
  if (!w.measure && !w.count) {
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

  // A measurement's exact value inside one of its ranges is that range ("1000 L" beside "500 - 1000 L"): the range
  // already counts it (inRange), so it goes rather than overlap.
  if (w.measure && w.fit && !w.fromDoc) {
    const quantity = (it: Item) => {
      const q = w.fit!(it.vc.value);
      return typeof q === "object" ? q : null;
    };
    const ranges = w.items.map(quantity).filter((q): q is Quantity => Boolean(q?.range));
    const covered = w.items.filter((it) => {
      const q = quantity(it);
      if (!q || q.range || q.kind === "dims") return false;
      const n = q.nums[0]!;
      return ranges.some((r) =>
        r.range === "upto"
          ? n <= r.nums[0]!
          : r.range === "above"
            ? n >= r.nums[0]!
            : n >= r.nums[0]! && n <= r.nums[1]!,
      );
    });
    if (covered.length && covered.length < w.items.length) {
      w.items = w.items.filter((it) => !covered.includes(it));
      w.notes.push(
        `"${f.name}": left out ${covered.map((it) => it.vc.value).join(", ")}: inside a range it also shows.`,
      );
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
      const found = docKeys.get(it.key) ?? (paired ? w.labelOf(paired) : undefined);
      if (!found) continue;
      // Our wording stays when the document's adds a figure ours doesn't have: "Electric" is not
      // "0.5 kW Electric", which is one of several ratings the document wrote into one value.
      const docLabel =
        !w.measure && hasFigure(found) && !hasFigure(it.vc.value) ? it.vc.value : found;
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

// ───────────────────────────── 4 · a text ISQ that mixes figures with words ─────────────────────────────

/** A value with a number and a unit in it ("1 HP", "0.5 kW Electric"); counts like "2 Seater" have none. */
const hasFigure = (v: string) => figuresIn(v).length > 0;

/**
 * This ISQ in the live ISQs (input 4): the same name (ignoring filler words like "Type"), one name inside the
 * other, or else the one live ISQ that shares the most values with it (a tie is none).
 */
function liveFor(w: Work, live: DocMcat): DocMcat["isqs"][number] | null {
  const mine = nameTokens(w.f.name).join(" ");
  const named = live.isqs.find((q) => nameTokens(q.name).join(" ") === mine);
  if (named) return named;
  const own = new Set(nameTokens(w.f.name));
  const inside = live.isqs.filter((q) => {
    const t = nameTokens(q.name);
    return (
      t.length > 0 &&
      own.size > 0 &&
      (t.every((x) => own.has(x)) || [...own].every((x) => t.includes(x)))
    );
  });
  if (inside.length === 1) return inside[0]!;
  const keys = new Set(w.items.map((it) => it.key));
  const scored = live.isqs
    .map((q) => ({ q, n: q.values.filter((v) => keys.has(w.keyOf(v) ?? "")).length }))
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.n - a.n);
  return scored[0] && scored[0].n !== scored[1]?.n ? scored[0].q : null;
}

/** A name that counts something: "Number of Trays", "No. of Decks", "Capacity (Trays)", "Tray Count". */
const COUNT_NAME = /\b(number|no|nos|count|capacity)\b/i;
const COUNT_FILLER = new Set([
  "number",
  "no",
  "nos",
  "count",
  "capacity",
  "of",
  "the",
  "per",
  "and",
]);
/** Number words a count can be written with: "Single Flavour" is 1 flavour, "Double Trolley" 2 trolleys. */
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  single: 1,
  two: 2,
  double: 2,
  dual: 2,
  twin: 2,
  three: 3,
  triple: 3,
  four: 4,
  five: 5,
  six: 6,
};
/** "24 Tray", "Single Flavour", "2+1 Flavour": a number (or number word, or a sum) and a noun. */
const COUNT_VALUE = /^(\d+(?:\.\d+)?|\d+\s*\+\s*\d+|[a-z]+)\s+([a-z]+)$/i;
/** A count word without its plural or its British spelling: "Flavours" and "Flavor" are one, "Trays" is "tray". */
const countStem = (word: string) => stem(word.toLowerCase()).replace(/our$/, "or");

interface Count {
  stem: string;
  singular: string;
  plural: string;
  /** The name states the noun, so a bare "5" is 5 of it. */
  bare: boolean;
}

/**
 * The noun a name states it counts: "Number of Trays", "No. of Decks", "Capacity (Trays)", "Tray Count", or a
 * thing a machine has a number of ("Tray Capacity", "Trolley Capacity": COUNT_NOUN).
 */
function namedNoun(name: string): string | null {
  const measure = measureKind(name);
  if (measure && isSpatial(measure)) return null;
  return (
    name.match(/\b(?:number|no\.?|nos\.?)\s+of\s+([a-z]+)/i)?.[1] ??
    countedInBrackets(name)?.split(/\s+/).pop() ??
    name.match(/\b([a-z]+)\s+count\b/i)?.[1] ??
    name.match(COUNT_NOUN)?.[0] ??
    null
  );
}

/** A value as a count of the noun: its number, or null for a sum ("2+1 Flavour"), which is kept as written. */
function countIn(value: string, count: Count): { n: number | null } | null {
  const v = value.trim();
  if (count.bare && /^\d+$/.test(v)) return { n: Number(v) };
  const m = v.match(COUNT_VALUE);
  if (!m || countStem(m[2]!) !== count.stem) return null;
  const num = m[1]!.toLowerCase();
  if (num.includes("+")) return { n: null };
  if (/^\d/.test(num)) return { n: Number(num) };
  return num in NUMBER_WORDS ? { n: NUMBER_WORDS[num]! } : null;
}

const makeCount = (word: string, bare: boolean): Count => {
  const plural = /s$/i.test(word) ? word : `${word}s`;
  // "Lanes" → "Lane", "Boxes" → "Box", "Trays" → "Tray".
  const singular = /(s|x|z|ch|sh)es$/i.test(plural) ? plural.slice(0, -2) : plural.slice(0, -1);
  return { stem: countStem(word), singular, plural, bare };
};

/** A count ISQ compares its values by number and writes them one way ("10", "10 tray" → "10 Trays"). */
function applyCount(w: Work, count: Count) {
  w.count = count;
  w.keyOf = (label) => {
    const n = countIn(label, count)?.n;
    return n != null ? `#${n} ${count.stem}` : valueKey(label) || null;
  };
  w.labelOf = (label) => {
    const n = countIn(label, count)?.n;
    return n != null ? `${n} ${n === 1 ? count.singular : count.plural}` : tidy(label);
  };
}

/**
 * A live ISQ's or the category document's values as this ISQ's items: in the list's order and wording (one
 * spelling: "4 Tray" is "4 Trays" in a count ISQ), each scored on the data (a range on the values inside it) and
 * Medium at the least. The list is someone's choice of options, so nothing in it is dropped as a duplicate.
 */
function listItems(w: Work, values: string[], source: "live" | "doc", from: string): Item[] {
  const items: Item[] = [];
  for (const v of values) {
    if (isJunk(v)) continue;
    const key = w.keyOf(v);
    if (!key || items.some((it) => it.key === key)) continue;
    const own = w.items.find((it) => it.key === key);
    const label = w.labelOf(v);
    const s = score(inRange(w, label) ?? w.groups.get(key), w.src);
    items.push({
      key,
      origs: own?.origs ?? [],
      vc: {
        value: label,
        ...s,
        level: s.level === "Low" ? "Medium" : s.level,
        why: `${s.level === "Low" && s.listings === 0 && s.demand_pct === null ? "" : `${s.why} · `}from ${from}`,
        source,
      },
    });
  }
  return items;
}

/**
 * What a count ISQ counts: the noun its name states ("Capacity (Trays)", which also makes a bare "5" a count), or
 * else the name word most of its values count ("Size" no, "Tray Capacity" with "4 Tray", "6 Trays" yes). Written
 * as the name has it ("Tray" / "Trays"). null when the name isn't a count or fewer than two values are.
 */
function countOf(name: string, labels: string[]): Count | null {
  const named = namedNoun(name);
  if (named) {
    const c = makeCount(named, true);
    if (labels.filter((l) => countIn(l, c)).length >= 2) return c;
  }
  if (!COUNT_NAME.test(name)) return null;
  let best: { word: string; n: number } | null = null;
  for (const word of name.match(/[a-z]+/gi) ?? []) {
    if (word.length < 3 || COUNT_FILLER.has(word.toLowerCase())) continue;
    const c = makeCount(word, false);
    const n = labels.filter((l) => countIn(l, c)).length;
    if (n >= 2 && (!best || n > best.n)) best = { word, n };
  }
  return best ? makeCount(best.word, false) : null;
}

/** An ISQ that says what powers or heats the machine: "Power Source", "Fuel Type", "Heating Source". */
const SOURCE_NAME =
  /\b(power|fuel|energy|heating|heat)\s*(source|type|medium)\b|\bfuel\b|\bheating\s*method\b/i;
/** What powers or heats a machine. A value of a source ISQ without one of these is something else. */
const SOURCE_WORD =
  /\b(electric\w*|gas|lpg|png|cng|lng|diesel|petrol|gasoline|kerosene|wood|coal|charcoal|biomass|pellets?|solar|steam|induction|oil|manual|hand|engine|motor|battery|generator|hydraulic|pneumatic|tractor|pto|thermic)\b/i;
/** Sources an MCAT's name can fix: an "Electric Rotary Rack Oven" is electric. */
const ENERGY_WORD = /\b(electric|gas|lpg|diesel|petrol|wood|coal|solar|steam|induction)\b/gi;

/**
 * A text ISQ that holds two attributes keeps only its own (values a buyer would choose between):
 * - the MCAT itself is not one of its options: "Dough Mixers" under the Dough Mixers MCAT's Mixer Type;
 * - values that mix figures with words ("0.5 kW Electric", "Gas", "1 HP", "20 kW" under Power Source);
 * - a count ISQ with values that aren't counts ("Conical Rounder" and "10 Kg/Hour" among "24 Tray", "40 Trays"),
 *   or whose name counts something its values don't ("Tray Capacity" holding kg/hr);
 * - a power or fuel source ISQ with values that aren't sources ("Liner", "Milking Cluster" beside "Electric").
 * With the live ISQ in input 4, such an ISQ takes the live ISQ's values, scored on the data and Medium at the
 * least. Without one, what doesn't belong goes: the figures when words are most of the values (when figures are
 * most, it is left as it is, with a warning); a count ISQ's other values when counts are at least two thirds; a
 * count ISQ whose values are all figures has nothing left; a source ISQ's non-sources. Last, a source the MCAT's
 * name fixes ("Electric Rotary Rack Oven") leaves only the values that have it; fewer than 2, and the ISQ isn't
 * shown — the MCAT's name already says it.
 */
function declutter(w: Work, live: DocMcat | null, mcat: string) {
  if (!w.eligible || w.mergedInto || w.measure) return;
  const list = (items: Item[]) => items.map((it) => it.vc.value).join(", ");

  // The MCAT itself is not one of its options.
  const mcatTokens = new Set(valueTokens(mcat));
  const itself = w.items.filter((it) => {
    const t = valueTokens(it.vc.value);
    return mcatTokens.size > 0 && t.length >= 2 && t.every((x) => mcatTokens.has(x));
  });
  if (itself.length) {
    w.items = w.items.filter((it) => !itself.includes(it));
    w.notes.push(`"${w.f.name}": left out ${list(itself)}: that is the MCAT itself.`);
  }

  const figures = w.items.filter((it) => hasFigure(it.vc.value));
  const words = w.items.filter((it) => !hasFigure(it.vc.value));
  const mixed = figures.length > 0 && words.length > 0;
  const kept = mixed && words.length >= figures.length ? words : w.items;
  const count = w.count;
  const counts = count ? kept.filter((it) => countIn(it.vc.value, count)) : [];
  const strays = count ? kept.filter((it) => !countIn(it.vc.value, count)) : [];
  // Counts must be a clear majority before anything else in a count ISQ is called a stray.
  const strayCounts = Boolean(count) && strays.length > 0 && counts.length >= 2 * strays.length;
  const noun = namedNoun(w.f.name);
  const wrongUnit = Boolean(noun) && !count && figures.length > 0 && words.length === 0;
  const source = SOURCE_NAME.test(w.f.name) && w.items.some((it) => SOURCE_WORD.test(it.vc.value));
  const nonSources = source ? kept.filter((it) => !SOURCE_WORD.test(it.vc.value)) : [];

  if (mixed || strayCounts || wrongUnit || nonSources.length) {
    const why = [
      mixed ? `figures (${list(figures)}) with words (${list(words)})` : "",
      strayCounts
        ? `${count!.plural.toLowerCase()} (${list(counts)}) with other things (${list(strays)})`
        : "",
      wrongUnit ? `figures (${list(figures)}) under a name that counts ${noun!.toLowerCase()}` : "",
      nonSources.length ? `things that aren't power or fuel sources (${list(nonSources)})` : "",
    ]
      .filter(Boolean)
      .join(", and ");
    const isq = live ? liveFor(w, live) : null;
    if (isq) {
      // A name that counts something writes the live counts one way too ("2 Tray" → "2 Trays").
      if (!w.count && noun) applyCount(w, makeCount(noun, true));
      const items = listItems(w, isq.values, "live", `the live ISQ ${isq.name}`);
      if (items.length >= MIN_VALUES) {
        w.notes.push(
          `"${w.f.name}": its values mixed ${why}, so they were taken from the live ISQ "${isq.name}" (input 4): ${list(items)}.`,
        );
        w.items = items;
        w.fromLive = isq.name;
        fixedSource(w, mcat);
        return;
      }
    }

    // Without a live ISQ: what doesn't belong goes.
    if (mixed) {
      if (words.length < figures.length && !wrongUnit) {
        w.warnings.push(
          `"${w.f.name}" mixes figures (${list(figures)}) with words (${list(words)}), and input 4 has no live ISQ for it to take values from.`,
        );
        return;
      }
      const kinds = [
        ...new Set(
          figures.flatMap((it) =>
            figuresIn(it.vc.value).map((q) => KIND_PLURAL[q.kind as keyof typeof KIND_PLURAL]),
          ),
        ),
      ];
      w.items = words;
      w.notes.push(
        `"${w.f.name}": left out ${list(figures)}: ${kinds.join(" and ")}, not ${w.f.name} values.`,
      );
    }
    if (wrongUnit) {
      w.items = [];
      w.notes.push(
        `"${w.f.name}": its values (${list(figures)}) are figures, but its name counts ${noun!.toLowerCase()}, so it isn't shown.`,
      );
    }
    if (strayCounts) {
      w.items = w.items.filter((it) => !strays.includes(it));
      w.notes.push(
        `"${w.f.name}": left out ${list(strays)}: not numbers of ${count!.plural.toLowerCase()}.`,
      );
    }
    if (nonSources.length) {
      w.items = w.items.filter((it) => !nonSources.includes(it));
      w.notes.push(`"${w.f.name}": left out ${list(nonSources)}: not power or fuel sources.`);
    }
  }
  fixedSource(w, mcat);
}

/**
 * A source the MCAT's name fixes: under an "Electric Rotary Rack Oven", a power source without "Electric" ("Gas",
 * "Wood") contradicts the MCAT and goes. With fewer than 2 values left the ISQ isn't shown: the name says it.
 */
function fixedSource(w: Work, mcat: string) {
  if (!SOURCE_NAME.test(w.f.name)) return;
  const fixed = [...new Set((mcat.match(ENERGY_WORD) ?? []).map((x) => x.toLowerCase()))];
  if (!fixed.length) return;
  const has = (v: string) => fixed.some((x) => new RegExp(`\\b${x}`, "i").test(v));
  const against = w.items.filter((it) => !has(it.vc.value));
  if (!against.length) return;
  w.items = w.items.filter((it) => has(it.vc.value));
  w.notes.push(
    `"${w.f.name}": left out ${against.map((it) => it.vc.value).join(", ")}: the MCAT's name says ${fixed.join(" / ")}${w.items.length < MIN_VALUES ? ", so this ISQ isn't shown" : ""}.`,
  );
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
  return ordered(w, high.length >= HIGH_ONLY_AT ? high : strong(w));
}

/**
 * Values in their display order: a live ISQ's in its own order, the rest best first; either way, values that
 * all begin with a number go smallest first ("1 Tray", "2 Trays", "4 Trays").
 */
function ordered(w: Work, items: Item[]): Item[] {
  return inOrder(w, w.fromLive ? w.items.filter((it) => items.includes(it)) : sorted(items));
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
  // Every Tier 1 ISQ and every Tier 2 High one can be shown, so each of them may need the document.
  const works = filters.filter(isEligible).map((f) => buildWork(f, ev, null));
  return works.filter((w) => Boolean(measureKind(w.f.name)) || isThin(w)).map((w) => w.f);
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
  /** This MCAT's live ISQs (input 4 as JSON): where a text ISQ mixing figures with words takes its values. */
  liveIsqs: DocMcat | null = null,
  /** The MCAT's name (for values that are the MCAT itself, or contradict it) and its category document. */
  opts: { mcat?: string | undefined; doc?: DocMcat | null } = {},
): SelectReport {
  const pairOf = new Map(pairs.map((p) => [p.filter, p]));
  const works = filters.map((f) =>
    buildWork(f, ev, isEligible(f) ? (pairOf.get(f) ?? null) : null),
  );
  const notes: string[] = [];
  const warnings: string[] = [];

  // Every Tier 1 / Tier 2 High ISQ is shown, so two ISQs for one attribute ("Size", "Dimensions") both are: they
  // are not merged. A value under both stays under the one where it is stronger (below). Best ISQ first.
  const live = works.filter((w) => w.eligible).sort((a, b) => better(a, b, ranking));

  for (const w of works) boost(w);
  for (const w of works) declutter(w, liveIsqs, opts.mcat ?? "");

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

  // 5–7 · which ISQs are shown: every Tier 1 ISQ (High, Medium or Low) and every Tier 2 High one, and nothing
  // else. The tier is the only test — not how many values an ISQ has, nor whether another ISQ holds the same
  // attribute — and there is no cap on how many.
  const reason = new Map<Work, string>();
  for (const w of works) {
    const f = w.f;
    if (isExcludedIsq(f.name)) reason.set(w, "Price and location are not ISQs");
    else if (f.tier === "Tier 3")
      reason.set(w, "Tier 3 (shown on the listing card, not as an ISQ)");
    else if (f.tier === "Tier 2" && f.confidence !== "High")
      reason.set(w, `Tier 2 with ${f.confidence} confidence (only High is picked from Tier 2)`);
  }

  // Write the result back onto the filters.
  for (const w of works) {
    const f = w.f;
    const all = ordered(w, w.items);
    f.values = all.map((it) => it.vc.value);
    if (all.length) f.value_confidence = all.map((it) => it.vc);
    else delete f.value_confidence;
    // Its High and Medium values; an ISQ with none of those still shows what it has (Low), not nothing.
    const showing = shownOf.get(w)!;
    f.selected_values = (showing.length ? showing : all).map((it) => it.vc.value);
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

  fillThin(filters, ev, liveIsqs, opts.doc ?? null, opts.mcat ?? "", notes);

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
/** An MCAT is given at least this many ISQs (fillThin). */
export const MIN_SHOWN_ISQS = 3;

/** Two ISQ names for one attribute: the same name words, or one name's words inside the other's. */
function namesMatch(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return small.every((t) => large.includes(t));
}

/**
 * An MCAT that shows fewer than MIN_SHOWN_ISQS ISQs — one with a few listings, where the model left everything in
 * Tier 3 — is given more: the live ISQs (input 4) in their priority order, then the category document's ISQs,
 * each with its own values, scored on the data and Medium at the least. Lists the model also made a Tier 1 or
 * Tier 2 High ISQ for go first (the data has them), and that ISQ is the one shown, with its listing evidence; a
 * list the model put in Tier 3 isn't used. Otherwise a new Tier 1 ISQ is added. Either way it is marked
 * `added_from`, and its note says why.
 */
function fillThin(
  filters: FilterRow[],
  ev: Pick<Evidence, "aggregation" | "listing">,
  live: DocMcat | null,
  doc: DocMcat | null,
  mcat: string,
  notes: string[],
) {
  let need = MIN_SHOWN_ISQS - filters.filter((f) => f.selected).length;
  if (need <= 0) return;
  const taken = filters.filter((f) => f.selected).map((f) => f.name);
  const hidden = (name: string) => filters.find((f) => !f.selected && namesMatch(f.name, name));
  const lists = [
    ...(live?.isqs ?? []).map((q) => ({ q, from: "live" as const })),
    ...(doc?.isqs ?? []).map((q) => ({ q, from: "doc" as const })),
  ].filter(({ q }) => !isExcludedIsq(q.name));
  // The model's own (hidden) ISQ for a list goes first when it may be shown: Tier 1, or Tier 2 High. One it put
  // in Tier 3 (or Tier 2 below High) stays hidden, and its list isn't used — the tier is the model's call.
  const order = [
    ...lists.filter(({ q }) => hidden(q.name) && isEligible(hidden(q.name)!)),
    ...lists.filter(({ q }) => !hidden(q.name)),
  ];
  const added: string[] = [];
  for (const { q, from } of order) {
    if (need <= 0) break;
    if (taken.some((n) => namesMatch(n, q.name))) continue;
    const values = q.values.filter((v) => !isJunk(v));
    if (values.length < MIN_VALUES) continue;
    const old = hidden(q.name);
    const spec =
      old?.linked_listing_spec ??
      ev.listing?.fields.find((x) => norm(x.key) === norm(q.name))?.key ??
      null;
    const probe: FilterRow = {
      rank: old?.rank ?? filters.length + 1,
      tier: old?.tier ?? "Tier 1",
      name: old?.name ?? q.name,
      ui_pattern: values.length <= 4 ? "single-select" : "multi-select checkboxes",
      values,
      confidence: old?.confidence ?? "Low",
      rationale: old?.rationale ?? "",
      linked_listing_spec: spec,
      linked_dimension: old?.linked_dimension ?? null,
    };
    const w = buildWork(probe, ev, null);
    const label =
      from === "live" ? `the live ISQ "${q.name}"` : `the category document's "${q.name}"`;
    w.items = listItems(w, values, from, label);
    // A source the MCAT's name fixes still holds ("Electric Rotary Rack Oven": no "Gas").
    fixedSource(w, mcat);
    if (w.items.length < MIN_VALUES) continue;
    // Another ISQ already shows these values (the document's "Flavour Configuration" beside "Number of Flavors").
    const shownKeys = new Set(
      filters
        .filter((f) => f.selected)
        .flatMap((f) => (f.selected_values ?? []).map((v) => valueKey(v))),
    );
    if (w.items.filter((it) => shownKeys.has(valueKey(it.vc.value))).length >= 2) continue;
    // A live ISQ keeps its own order; the document's values are listed best first.
    if (from === "live") w.fromLive = q.name;
    const all = ordered(w, w.items);
    const row = old ?? probe;
    row.values = all.map((it) => it.vc.value);
    row.value_confidence = all.map((it) => it.vc);
    row.selected_values = shown(w).map((it) => it.vc.value);
    row.selected = true;
    row.ui_pattern = probe.ui_pattern;
    row.added_from = from;
    row.isq_note = `Added: ${mcat || "this MCAT"} showed fewer than ${MIN_SHOWN_ISQS} ISQs, so this one is taken from ${label}.`;
    if (spec) row.linked_listing_spec = spec;
    if (w.shape) row.unit = w.shape.unit;
    else delete row.unit;
    delete row.select_note;
    if (!old) filters.push(row);
    taken.push(row.name);
    added.push(`${row.name} (from ${label})`);
    need--;
  }
  if (added.length)
    notes.push(
      `${mcat || "This MCAT"} showed fewer than ${MIN_SHOWN_ISQS} ISQs: added ${added.join(", ")}.`,
    );
}

export function checkSelection(filters: FilterRow[]): string[] {
  const failed: string[] = [];
  const picked = filters.filter((f) => f.selected);

  for (const f of picked) {
    const name = `"${f.name}"`;
    const values = f.selected_values ?? [];
    const level = new Map((f.value_confidence ?? []).map((c) => [c.value, c.level]));
    if (isExcludedIsq(f.name)) failed.push(`${name} is a price or location ISQ but is shown.`);
    if (f.tier === "Tier 3") failed.push(`${name} is Tier 3 but is shown.`);
    if (f.tier === "Tier 2" && f.confidence !== "High")
      failed.push(`${name} is Tier 2 with ${f.confidence} confidence but is shown.`);
    // An ISQ with no High or Medium value shows its Low ones instead (it is shown whatever its values).
    const weak = values.filter((v) => level.get(v) !== "High" && level.get(v) !== "Medium");
    if (weak.length && weak.length < values.length)
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
    // A live ISQ's or the document's own options are a list someone made, not duplicates ("Automatic" beside
    // "Semi Automatic").
    const listed = new Set(
      (f.value_confidence ?? [])
        .filter((c) => c.source === "live" || c.source === "doc")
        .map((c) => c.value),
    );
    if (!measured)
      for (const a of values)
        for (const b of values)
          if (a !== b && !listed.has(a) && isGenericOf(a, b))
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
