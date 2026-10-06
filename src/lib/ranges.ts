import type { ListingField, ListingProfile } from "./data";
import type { FilterRow } from "./filter-gen";
import { HIGH_AT, MEDIUM_AT, type ValueConfidence } from "./value-confidence";

/**
 * Lower / upper bounds for the numeric ISQ values of a filter ("5,001 - 10,000 sq ft" → 5001 … 10000), so
 * a search can match listings by number instead of by the option's text. The model proposes the bounds
 * (skill 14); code keeps one only when the number is in the option's own text, so a bound can never be
 * invented or converted. A bound that fails the check is dropped and the option stays a plain label.
 */
export interface ValueRange {
  /** The option's text, exactly as in the filter's `values`. */
  value: string;
  /** Lower and upper bound as written in the value. null = open end ("Up to X" has no lower bound). */
  min: number | null;
  max: number | null;
  /** The unit the bounds are in, as the value writes it: "sq ft", "₹", "₹/piece". */
  unit: string;
  /** Whether the bound itself is inside the range. Absent = inside (a value "5,001 - 10,000" holds both ends). */
  min_inclusive?: boolean;
  max_inclusive?: boolean;
  /** Listings whose value falls in this range, and their share (%) of all the listings profiled. */
  listings?: number;
  fill_pct?: number;
}

/** How a buyer's limit on one axis is read: inside a range, at most (fits a space), at least (bigger is better). */
export type AxisMatch = "between" | "at_most" | "at_least";

export interface DimensionAxis {
  name: string;
  match: AxisMatch;
  /** Smallest and largest size on this axis among the filter's options, in the filter's unit: the slider's ends. */
  min: number;
  max: number;
}

export interface DimensionOption {
  /** The option's text, exactly as in the filter's `values`. */
  value: string;
  /** Size on each axis (axis name → number), in the filter's unit. An axis the value doesn't give is absent. */
  sizes: Record<string, number>;
  /** The value wrote no unit anywhere; the unit is the model's reading of the filter. */
  unit_assumed?: boolean;
}

/**
 * A filter whose values are sizes written as several numbers ("10x12 ft", "40ft x 10ft x 8.5ft"): one slider per
 * axis, each with a lower and upper limit in one unit. The model names the axes and says how each is matched;
 * code reads the numbers, converts the units and checks every number against the value's own text.
 */
export interface DimensionSpec {
  /** ft, m, mm, cm or in: every size here is in it. */
  unit: LengthUnit;
  axes: DimensionAxis[];
  /** Length and width are interchangeable for a buyer (a footprint), so a 10x20 matches a 20x10 request. */
  rotation_ok: boolean;
  /** The model's assumptions in plain words: axis order, a unit it had to assume, values with no height. */
  note: string;
  options: DimensionOption[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Words that make one side of a value open: "Up to 15 meters", "Above 60", "50,000+", "≥ 10". */
const OPEN_END =
  /\b(up ?to|upto|under|below|less than|within|max(imum)?|above|over|more than|greater than|at least|(?<!\d\s*)min(imum)?|onwards?|and (above|up|more))\b|[<>≤≥]|\d\s*\+/i;
/** "10x12 ft", "30m x 60m x 8m", "4' x 4' x 7'": several quantities in one value, not one range. */
const DIMENSIONS = /\d\s*[a-z'"′″]*\s*[x×]\s*\d/i;
/** Standards, grades and zones carry digits but aren't quantities: "IS 2062 E450", "ISO 9001:2015", "Zone III". */
const NOT_A_QUANTITY =
  /\b(IS|ISO|BS|EN|DIN|ASTM|IEC|IP|NEMA|UL|ANSI)\s*[-:]?\s*\d|\b(zone|grade)\b/i;

const MULTIPLIER: Record<string, number> = {
  k: 1e3,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  lacs: 1e5,
  crore: 1e7,
  crores: 1e7,
  cr: 1e7,
};

/** Every number in a text, thousands commas removed and Indian words applied: "₹1.5 Lakh" → 150000. */
export function numbersIn(text: string): number[] {
  const t = text.replace(/(?<=\d),(?=\d{2,3}\b)/g, "");
  const out: number[] = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)(?:\s*(lakhs?|lacs?|crores?|cr|k)\b)?/gi)) {
    const n = Number(m[1]);
    const mult = m[2] ? (MULTIPLIER[m[2].toLowerCase()] ?? 1) : 1;
    if (Number.isFinite(n)) out.push(n * mult);
  }
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/** A value with its bracketed notes taken out: "25 ft (7.5 m)" → "25 ft". */
const withoutBrackets = (label: string) => label.replace(/\([^)]*\)/g, " ");

/** A bound as the model wrote it: a number, a numeric string, or nothing (null). undefined = unusable. */
function bound(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
}

/** The bounds if they are right for this value's text, else null. */
export function checkBounds(
  label: string,
  rawMin: unknown,
  rawMax: unknown,
): { min: number | null; max: number | null } | null {
  const min = bound(rawMin);
  const max = bound(rawMax);
  if (min === undefined || max === undefined) return null;
  if (min === null && max === null) return null;
  if (min !== null && max !== null && min > max) return null;
  if (DIMENSIONS.test(label) || NOT_A_QUANTITY.test(label)) return null;

  // "25 ft (7.5 m)": the bracket restates the same quantity in another unit, so it isn't a second number.
  const core = withoutBrackets(label);
  const nums = numbersIn(core);
  const inLabel = (n: number) => nums.some((x) => close(x, n));
  if ((min !== null && !inLabel(min)) || (max !== null && !inLabel(max))) return null;
  if (OPEN_END.test(core)) return { min, max };

  // A closed value is one number (min = max) or a span of exactly two (its lowest and highest number).
  if (min === null || max === null) return null;
  const distinct = [...new Set(nums)];
  if (distinct.length === 1)
    return close(min, distinct[0]!) && close(max, distinct[0]!) ? { min, max } : null;
  if (distinct.length === 2)
    return close(min, Math.min(...distinct)) && close(max, Math.max(...distinct))
      ? { min, max }
      : null;
  return null;
}

const cleanUnit = (u: unknown) => (typeof u === "string" ? u.trim().slice(0, 24) : "");

export interface AppliedRanges {
  /** Filters that got ranges, and the options with bounds across them. */
  filters: number;
  options: number;
  /** "Filter: option" for every option the model gave bounds for that failed the check. */
  skipped: string[];
  /** Filters the model left alone (or the call failed) whose bounds code read itself from the values. */
  inferred: number;
  /** Filters whose exact values were folded into ranges or turned into "less than / a to b / more than" buckets. */
  regrouped: number;
}

/**
 * Reads the model's answer ({"ranges": [{"filter", "unit", "options": [{"value", "min", "max"}]}]}) and sets
 * `ranges` on the filters it is right for. A filter keeps its ranges only when at least two of its options
 * pass: one lone bounded option beside plain labels is not a numeric filter.
 *
 * Then, for every filter with bounds (the model's or code's own reading of values with a measurable unit):
 * exact values are folded into the ranges they fall in, or, when all values are exact, turned into buckets
 * ("Less than 2.5 m", "2.5 to 4 m", …, "More than 5 m") whose edges are numbers of the filter's own values;
 * and each range gets its listing fill rate. `data` null = the model call failed or was skipped.
 */
export function applyRanges(
  filters: FilterRow[],
  data: unknown,
  listing: ListingProfile | null = null,
): AppliedRanges {
  const applied: AppliedRanges = { filters: 0, options: 0, skipped: [], inferred: 0, regrouped: 0 };
  const byName = new Map(filters.map((f) => [norm(f.name), f]));
  const list = (data as { ranges?: unknown } | null)?.ranges;
  const edgesOf = new Map<FilterRow, unknown>();

  for (const item of (Array.isArray(list) ? list : []) as Record<string, unknown>[]) {
    const f = byName.get(norm(String(item?.["filter"] ?? "")));
    if (!f) continue;
    // Counts of things (seats, persons, doors) stay exact options: nothing is built for them.
    if (COUNT_WORDS.test(cleanUnit(item["unit"]).toLowerCase())) continue;
    if (item["kind"] === "buckets") {
      edgesOf.set(f, item["edges"]);
      continue;
    }
    const options = item["options"];
    if (!Array.isArray(options)) continue;
    // Sizes written as several numbers ("10x12 ft") become a filter with one slider per axis.
    if (item["kind"] === "dimensions" || Array.isArray(item["axes"])) {
      applyDimensions(f, item, applied);
      continue;
    }
    const unit = cleanUnit(item["unit"]);
    const labelOf = new Map(f.values.map((v) => [v.toLowerCase().trim(), v]));
    const found = new Map<string, ValueRange>();
    for (const o of options as Record<string, unknown>[]) {
      const label = labelOf.get(
        String(o?.["value"] ?? "")
          .toLowerCase()
          .trim(),
      );
      if (!label || found.has(label)) continue;
      const b = checkBounds(label, o["min"], o["max"]);
      if (b) found.set(label, { value: label, ...b, unit, ...inclusivityOf(label) });
      else applied.skipped.push(`${f.name}: ${label}`);
    }
    if (found.size < 2) {
      if (found.size === 1) applied.skipped.push(`${f.name}: only one option had usable bounds`);
      continue;
    }
    f.ranges = f.values.flatMap((v) => (found.has(v) ? [found.get(v)!] : []));
    applied.filters++;
    applied.options += f.ranges.length;
  }

  // Sizes ("10 x 10", "20 x 10 x 8") win over single-quantity ranges: a filter with them is one size filter,
  // even when the model (or a first reading) gave it ranges for its plain lengths.
  for (const f of filters) {
    if (f.dimensions || !f.values.some((v) => /\d/.test(v))) continue;
    const item = inferDimensionItem(f);
    if (!item) continue;
    const before = f.ranges;
    delete f.ranges;
    const tmp: AppliedRanges = { filters: 0, options: 0, skipped: [], inferred: 0, regrouped: 0 };
    applyDimensions(f, item, tmp);
    if (f.dimensions) {
      applied.filters += before?.length ? 0 : 1;
      applied.options += tmp.options - (before?.length ?? 0);
      applied.inferred++;
    } else if (before) f.ranges = before;
  }

  // The model left a numeric filter alone, or its call failed: read the bounds in code, so a filter with
  // measurable values is never left as plain labels. Counts (2 Doors), grades and sizes stay as they are.
  // Where the model's ranges cover fewer values than code can read (a filter mixing m and ft), code's win.
  for (const f of filters) {
    if (f.dimensions || !f.values.some((v) => /\d/.test(v))) continue;
    const read = inferRanges(f);
    if (!read || read.length <= (f.ranges?.length ?? 0)) continue;
    if (f.ranges?.length) applied.options += read.length - f.ranges.length;
    else {
      applied.filters++;
      applied.options += read.length;
      applied.inferred++;
    }
    f.ranges = read;
  }

  // Exact values into ranges or buckets, open ends, then the listing fill rate of every range.
  for (const f of filters) {
    if (!f.ranges?.length) continue;
    const field = listingFieldOf(f, listing);
    const regrouped = regroup(f, edgesOf.get(f), field);
    if (regrouped) applied.regrouped++;
    const ended = closeEnds(f);
    addFill(f, field, listing, regrouped || ended);
  }
  return applied;
}

const num = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 6 });

/** A bound with its unit: "₹750", "₹750/piece" (money goes in front), "5,000 sq ft". */
function withUnit(n: number, unit: string): string {
  if (unit.startsWith("₹")) return `₹${num(n)}${unit.slice(1)}`;
  return unit ? `${num(n)} ${unit}` : num(n);
}

/** "5,001 – 10,000 sq ft", "≤ 5,000 sq ft", "≥ 60 meters", "= 80 mm", "₹750 – ₹962". */
export function rangeText(r: ValueRange): string {
  if (r.min !== null && r.max !== null) {
    if (r.min === r.max) return `= ${withUnit(r.min, r.unit)}`;
    // Money goes in front of each number; any other unit is written once, at the end.
    return r.unit.startsWith("₹") || !r.unit
      ? `${withUnit(r.min, r.unit)} – ${withUnit(r.max, r.unit)}`
      : `${num(r.min)} – ${num(r.max)} ${r.unit}`;
  }
  if (r.max !== null) return `${r.max_inclusive === false ? "<" : "≤"} ${withUnit(r.max, r.unit)}`;
  return `${r.min_inclusive === false ? ">" : "≥"} ${withUnit(r.min!, r.unit)}`;
}

/**
 * The whole filter as one range: its lowest bound to its highest, whatever options they come from.
 * "Under ₹750" … "Above ₹2.1 Lakh" → ₹750 – ₹2,10,000. null when no option has a bound.
 */
export function overallRange(ranges: ValueRange[] | undefined): ValueRange | null {
  const bounds = (ranges ?? [])
    .flatMap((r) => [r.min, r.max])
    .filter((n): n is number => n !== null);
  if (!bounds.length) return null;
  return {
    value: "",
    min: Math.min(...bounds),
    max: Math.max(...bounds),
    unit: ranges!.find((r) => r.unit)?.unit ?? "",
  };
}

// ───────────────────────────── sizes with several numbers: "10x12 ft" ─────────────────────────────

export type LengthUnit = "ft" | "m" | "mm" | "cm" | "in";
/** Metres in one of each unit: the fixed table code converts with (the model never converts). */
const METRES: Record<LengthUnit, number> = { m: 1, ft: 0.3048, in: 0.0254, cm: 0.01, mm: 0.001 };
const UNIT_WORDS: Record<string, LengthUnit> = {
  ft: "ft",
  feet: "ft",
  foot: "ft",
  fts: "ft",
  "'": "ft",
  "′": "ft",
  "’": "ft",
  m: "m",
  mt: "m",
  mtr: "m",
  mtrs: "m",
  meter: "m",
  meters: "m",
  metre: "m",
  metres: "m",
  mm: "mm",
  millimeter: "mm",
  millimeters: "mm",
  millimetre: "mm",
  millimetres: "mm",
  cm: "cm",
  centimeter: "cm",
  centimeters: "cm",
  centimetre: "cm",
  centimetres: "cm",
  in: "in",
  inch: "in",
  inches: "in",
  '"': "in",
  "″": "in",
  "”": "in",
};

/** "Feet" / "ft." / "'" → "ft"; null for anything that isn't a length unit this table knows. */
export function lengthUnit(raw: unknown): LengthUnit | null {
  if (typeof raw !== "string") return null;
  return UNIT_WORDS[raw.toLowerCase().replace(/[.\s]/g, "")] ?? null;
}

/** A length unit written right after a number: "12 ft", "30m", "4'", "8.5 feet". */
const UNIT_AFTER_NUMBER =
  /\d\s*(feet|foot|fts?\.?|mtrs?\.?|meters?|metres?|mm|cm|inch(?:es)?|in\b|m\b|['"′″’”])/gi;

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** The "x" between two sizes: after a number or a unit, before a number ("Box 10x12" splits at the second x only). */
const DIMENSION_SPLIT =
  /(?<=[\d'"′″.]|\d\s*(?:ft|feet|foot|mm|cm|mtrs?|meters?|metres?|m|in|inch(?:es)?)\.?)\s*[x×]\s*(?=\d)/i;

/** The sizes of one value if the model's parts are right for its text, else null. */
function checkDimensionOption(
  label: string,
  parts: unknown,
  axes: string[],
  unit: LengthUnit,
): { sizes: Record<string, number>; assumed: boolean } | null {
  if (!Array.isArray(parts) || OPEN_END.test(label) || NOT_A_QUANTITY.test(label)) return null;
  const pieces = withoutBrackets(label).split(DIMENSION_SPLIT);
  if (pieces.length > 3 || parts.length !== pieces.length) return null;

  // One unit in the label (written once at the end, or on every part), or none; mixed units are skipped.
  const written = new Set(
    pieces.flatMap((p) => [...p.matchAll(UNIT_AFTER_NUMBER)].map((m) => lengthUnit(m[1]))),
  );
  if (written.size > 1 || written.has(null)) return null;
  const inLabel = [...written][0] ?? null;
  // A single number is a size only with a length unit: "20 ft" is a length, "3 seater" is not.
  if (pieces.length === 1 && inLabel === null) return null;

  const sizes: Record<string, number> = {};
  for (let i = 0; i < pieces.length; i++) {
    const numbers = [...new Set(numbersIn(pieces[i]!))];
    const part = parts[i] as Record<string, unknown> | null;
    const axis = axes.find((a) => norm(a) === norm(String(part?.["axis"] ?? "")));
    const n = bound(part?.["number"]);
    if (numbers.length !== 1 || !axis || typeof n !== "number" || !close(n, numbers[0]!))
      return null;
    if (axis in sizes) return null;
    const given =
      part?.["unit"] === undefined || part?.["unit"] === "" ? null : lengthUnit(part?.["unit"]);
    if (part?.["unit"] && given === null) return null;
    // The unit the label writes wins; a different one from the model is a wrong reading.
    if (inLabel && given && given !== inLabel) return null;
    const from = inLabel ?? given ?? unit;
    sizes[axis] = round4((n * METRES[from]) / METRES[unit]);
  }
  return { sizes, assumed: inLabel === null };
}

const MATCHES: AxisMatch[] = ["between", "at_most", "at_least"];

/** Reads one {"kind": "dimensions", …} item of the model's answer and sets `dimensions` on the filter. */
function applyDimensions(f: FilterRow, item: Record<string, unknown>, applied: AppliedRanges) {
  const unit = lengthUnit(item["unit"]);
  const rawAxes = Array.isArray(item["axes"]) ? (item["axes"] as unknown[]) : [];
  const seen = new Set<string>();
  const axisDefs = rawAxes
    .map((a) =>
      typeof a === "string"
        ? { name: a, match: "between" as AxisMatch }
        : {
            name: String((a as Record<string, unknown> | null)?.["name"] ?? ""),
            match: MATCHES.includes((a as Record<string, unknown>)["match"] as AxisMatch)
              ? ((a as Record<string, unknown>)["match"] as AxisMatch)
              : ("between" as AxisMatch),
          },
    )
    .map((a) => ({ ...a, name: a.name.trim().slice(0, 24) }))
    .filter((a) => a.name && !seen.has(norm(a.name)) && seen.add(norm(a.name)))
    .slice(0, 3);
  if (!unit || axisDefs.length < 2) {
    applied.skipped.push(`${f.name}: no usable unit or axes for its sizes`);
    return;
  }

  const labelOf = new Map(f.values.map((v) => [v.toLowerCase().trim(), v]));
  const found = new Map<string, DimensionOption>();
  for (const o of item["options"] as Record<string, unknown>[]) {
    const label = labelOf.get(
      String(o?.["value"] ?? "")
        .toLowerCase()
        .trim(),
    );
    if (!label || found.has(label)) continue;
    const ok = checkDimensionOption(
      label,
      o["parts"],
      axisDefs.map((a) => a.name),
      unit,
    );
    if (ok)
      found.set(label, {
        value: label,
        sizes: ok.sizes,
        ...(ok.assumed ? { unit_assumed: true } : {}),
      });
    else applied.skipped.push(`${f.name}: ${label}`);
  }
  if (found.size < 2) {
    if (found.size === 1) applied.skipped.push(`${f.name}: only one size could be read`);
    return;
  }

  const options = f.values.flatMap((v) => (found.has(v) ? [found.get(v)!] : []));
  // An axis no option gives (a "Height" nobody wrote) is dropped; the slider ends are the data's own.
  const axes = axisDefs.flatMap((a): DimensionAxis[] => {
    const sizes = options.flatMap((o) => (a.name in o.sizes ? [o.sizes[a.name]!] : []));
    return sizes.length ? [{ ...a, min: Math.min(...sizes), max: Math.max(...sizes) }] : [];
  });
  if (axes.length < 2) {
    applied.skipped.push(`${f.name}: sizes had fewer than two axes`);
    return;
  }
  f.dimensions = {
    unit,
    axes,
    rotation_ok: item["rotation_ok"] === true,
    note: typeof item["note"] === "string" ? item["note"].trim().slice(0, 200) : "",
    options,
  };
  applied.filters++;
  applied.options += options.length;
}

/** The one length unit a value writes ("ft" in "4 x 4 x 7 ft"), null when it writes none or several. */
function writtenLengthUnit(text: string): LengthUnit | null {
  const units = new Set([...text.matchAll(UNIT_AFTER_NUMBER)].map((m) => lengthUnit(m[1])));
  return units.size === 1 && !units.has(null) ? [...units][0]! : null;
}

/**
 * A size filter read by code, for when the model gave no sizes for it: at least two values are two or three
 * numbers joined by x ("10 x 10", "20 x 10 x 8", "4 x 4 x 7 ft"), and they are at least a third of the values.
 * Axes are length, width, height in written order; a single length with a unit ("20 ft") counts as a length;
 * a value with no unit takes the commonest unit written (ft when none is). Everything is said in the note.
 */
function inferDimensionItem(f: FilterRow): Record<string, unknown> | null {
  const real = f.values.filter((v) => !/^other/i.test(v));
  const multi: { v: string; pieces: string[] }[] = [];
  const singles: { v: string; n: number }[] = [];
  for (const v of real) {
    if (OPEN_END.test(v) || NOT_A_QUANTITY.test(v)) continue;
    const core = withoutBrackets(v);
    const pieces = core.split(DIMENSION_SPLIT);
    const ones = pieces.map((p) => [...new Set(numbersIn(p))]);
    if (pieces.length >= 2 && pieces.length <= 3 && ones.every((n) => n.length === 1))
      multi.push({ v, pieces });
    else if (pieces.length === 1 && ones[0]!.length === 1 && writtenLengthUnit(core))
      singles.push({ v, n: ones[0]![0]! });
  }
  if (multi.length < 2 || multi.length < real.length / 3) return null;

  const tally = new Map<LengthUnit, number>();
  for (const { v } of [...multi, ...singles.map((x) => ({ v: x.v }))]) {
    const u = writtenLengthUnit(withoutBrackets(v));
    if (u) tally.set(u, (tally.get(u) ?? 0) + 1);
  }
  const unit = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "ft";
  const names = ["Length", "Width", "Height"].slice(
    0,
    Math.max(...multi.map((m) => m.pieces.length)),
  );
  const options = [
    ...multi.map(({ v, pieces }) => {
      const written = writtenLengthUnit(withoutBrackets(v));
      return {
        value: v,
        parts: pieces.map((p, i) => ({
          axis: names[i],
          number: numbersIn(p)[0],
          ...(written ? { unit: written } : {}),
        })),
      };
    }),
    ...singles.map(({ v, n }) => ({
      value: v,
      parts: [{ axis: "Length", number: n, unit: writtenLengthUnit(withoutBrackets(v)) }],
    })),
  ];
  return {
    kind: "dimensions",
    unit,
    axes: names.map((name) => ({ name, match: "at_most" })),
    rotation_ok: /size|dimension|footprint|area|plot|room|cabin|shelter|house|building/i.test(
      f.name,
    ),
    note: `Read by code: axes taken in written order (${names.join(" × ")}), a single length counts as Length, and a value with no unit is taken in ${unit}.`,
    options,
  };
}

/** "Length 3 – 40 ft" (one size: "Height 7 ft"). */
export function axisText(a: DimensionAxis, unit: string): string {
  return a.min === a.max
    ? `${a.name} ${num(a.min)} ${unit}`
    : `${a.name} ${num(a.min)} – ${num(a.max)} ${unit}`;
}

/** "Length 10 × Width 12 ft" for one option. */
export function sizeText(spec: DimensionSpec, o: DimensionOption): string {
  const parts = spec.axes.flatMap((a) =>
    a.name in o.sizes ? [`${a.name} ${num(o.sizes[a.name]!)}`] : [],
  );
  return `${parts.join(" × ")} ${spec.unit}${o.unit_assumed ? " (unit assumed)" : ""}`;
}

const AXIS_MATCH_TEXT: Record<AxisMatch, string> = {
  between: "within the range",
  at_most: "up to the limit (must fit)",
  at_least: "at least the limit",
};
export const axisMatchText = (m: AxisMatch) => AXIS_MATCH_TEXT[m];

/** Floor area worked out from the first two axes of every option that has both: "15 – 2,400 sq ft". */
export function dimensionArea(
  spec: DimensionSpec,
): { min: number; max: number; unit: string } | null {
  const [a, b] = spec.axes;
  if (!a || !b) return null;
  const areas = spec.options.flatMap((o) =>
    a.name in o.sizes && b.name in o.sizes ? [o.sizes[a.name]! * o.sizes[b.name]!] : [],
  );
  if (!areas.length) return null;
  return {
    min: round4(Math.min(...areas)),
    max: round4(Math.max(...areas)),
    unit: `sq ${spec.unit}`,
  };
}

/** The whole filter's range as one line: a numeric filter's overall range, or each axis of a size filter. */
export function filterRangeText(f: FilterRow): string | null {
  if (f.dimensions) {
    const d = f.dimensions;
    const area = dimensionArea(d);
    return [
      ...d.axes.map((a) => axisText(a, d.unit)),
      ...(area && d.axes.length >= 2
        ? [`Area ${num(area.min)} – ${num(area.max)} ${area.unit}`]
        : []),
    ].join(" · ");
  }
  const whole = overallRange(f.ranges);
  return whole ? rangeText(whole) : null;
}

/** One line per option, for the step's working and the exports: "5,001 – 10,000 sq ft" or "Length 10 × Width 12 ft". */
export function rangeLines(f: FilterRow): string[] {
  if (f.dimensions)
    return f.dimensions.options.map((o) => `${o.value}  →  ${sizeText(f.dimensions!, o)}`);
  return (f.ranges ?? []).map(
    (r) =>
      `${r.value}  →  ${rangeText(r)}${r.fill_pct != null ? `  ·  fill ${r.fill_pct}% (${r.listings} listings)` : ""}`,
  );
}

// ───────────────── reading values in code, folding exact values into ranges, fill rates ─────────────────

/** [pattern, key]: the units code treats as measurable. Anything else ("Doors", "Cars", "Seats") is not read. */
const UNIT_KEYS: [RegExp, string][] = [
  [/^(sq ?(ft|feet|foot)|sqft|sft|square (feet|foot|ft))$/, "sq ft"],
  [/^(sq ?(m|meter|metre|mtr)s?|sqm|square (meter|metre)s?)$/, "sq m"],
  [/^(sq ?(yd|yard)s?|square yards?)$/, "sq yd"],
  [/^(kg|kgs|kilograms?|kilos?)$/, "kg"],
  [/^(g|gm|gms|grams?)$/, "g"],
  [/^(tons?|tonnes?|mt|mts|metric tons?)$/, "ton"],
  [/^(l|ltr|ltrs|litres?|liters?)$/, "litre"],
  [/^(ml|millilitres?|milliliters?)$/, "ml"],
  [/^(kw|kilowatts?)$/, "kW"],
  [/^(hp|horse ?power)$/, "hp"],
  [/^(w|watts?)$/, "W"],
  [/^kva$/, "kVA"],
  [/^(v|volts?)$/, "V"],
  [/^(days?)$/, "days"],
  [/^(weeks?|wks?)$/, "weeks"],
  [/^(months?)$/, "months"],
  [/^(years?|yrs?)$/, "years"],
  [/^(hours?|hrs?)$/, "hours"],
  [/^(lph|l\/h)$/, "LPH"],
  [/^(tph)$/, "TPH"],
  [/^(rpm)$/, "RPM"],
  [/^(cfm)$/, "CFM"],
  [/^(bar|psi|mpa|kpa)$/, "bar"],
  [/^(%|percent)$/, "%"],
];

/**
 * Units that count things: "6 seater", "20 persons", "4 cars", "2 doors". They stay exact options, however many
 * different numbers there are; a model answer that ranges one is ignored.
 */
const COUNT_WORDS =
  /^(seater|seaters|seats?|seating|persons?|people|pax|cars?|doors?|rooms?|floors?|storeys?|stories|bedrooms?|bhk|pcs|pieces?|nos|units?|sets?)$/i;

/** The measurable unit a unit text names ("sq.ft", "Sq Feet" → "sq ft"; "Meter" → "m"), "" for none, null for unknown. */
function unitKey(raw: string): string | null {
  const t = raw.toLowerCase().replace(/\./g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.startsWith("₹")) return t;
  const length = lengthUnit(t);
  if (length) return length;
  return UNIT_KEYS.find(([re]) => re.test(t))?.[1] ?? null;
}

const RANGE_WORDS =
  /\b(up ?to|upto|under|below|less than|within|max(imum)?|above|over|more than|greater than|at least|(?<!\d\s*)min(imum)?|onwards?|and (above|up|more)|to|from|between|lakhs?|lacs?|crores?|cr|k)\b/g;
/** Value words that make it a cap ("Up to 5000": no lower bound) or a floor ("Above 25,000": no upper bound). */
const CAP_WORDS = /\b(up ?to|upto|under|below|less than|within|max(imum)?)\b|[<≤]/i;
const FLOOR_WORDS =
  /\b(above|over|more than|greater than|at least|(?<!\d\s*)min(imum)?|onwards?|and (above|up|more))\b|[>≥]|\d\s*\+/i;

/** What is left of a value once its numbers and range words are taken out: its unit text. */
function unitText(label: string): string {
  if (/₹|\brs\.?\s*\d|\binr\b/i.test(label)) {
    const per = label.match(/\/\s*([a-z][a-z ]*)\s*$/i)?.[1];
    return per ? `₹/${per.trim().toLowerCase()}` : "₹";
  }
  return label
    .toLowerCase()
    .replace(/(?<=\d),(?=\d{2,3}\b)/g, "")
    .replace(/\d+(?:\.\d+)?/g, " ")
    .replace(RANGE_WORDS, " ")
    .replace(/[-–—+<>≤≥,()/:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Quantity {
  min: number | null;
  max: number | null;
  /** The measurable unit ("m", "sq ft", "₹"), "" when the value writes none. */
  key: string;
}

/** One plain quantity as a value writes it ("4 Meter", "Upto 5000", "5001-10000", "₹750 – ₹962"), else null. */
function readQuantity(full: string): Quantity | null {
  if (DIMENSIONS.test(full) || NOT_A_QUANTITY.test(full)) return null;
  const label = withoutBrackets(full);
  const nums = [...new Set(numbersIn(label))];
  if (!nums.length || nums.length > 2) return null;
  let min: number | null;
  let max: number | null;
  if (OPEN_END.test(label)) {
    if (nums.length !== 1) return null;
    if (CAP_WORDS.test(label)) [min, max] = [null, nums[0]!];
    else if (FLOOR_WORDS.test(label)) [min, max] = [nums[0]!, null];
    else return null;
  } else if (nums.length === 1) [min, max] = [nums[0]!, nums[0]!];
  else [min, max] = [Math.min(...nums), Math.max(...nums)];
  if (!checkBounds(label, min, max)) return null;
  const key = unitKey(unitText(label));
  return key === null ? null : { min, max, key };
}

/** "Under 750" and "Below 15 m" stop short of their number; "Above 60" and "More than 5" start after it. "Up to" and "at least" include it. */
function inclusivityOf(label: string): Pick<ValueRange, "min_inclusive" | "max_inclusive"> {
  return {
    ...(/\b(under|below|less than)\b|<(?!=)/i.test(label) ? { max_inclusive: false } : {}),
    ...(/\b(above|over|more than|greater than)\b|>(?!=)/i.test(label)
      ? { min_inclusive: false }
      : {}),
  };
}

const isPoint = (r: { min: number | null; max: number | null }) =>
  r.min !== null && r.min === r.max;

/** The unit as shown: money keeps its "₹/piece", lengths and the rest use the unit's short name. */
const displayUnit = (key: string) => key;

/** Units that convert into each other, by fixed factors: key → [kind, size in the kind's base unit]. */
const SAME_KIND: Record<string, [string, number]> = {
  m: ["length", 1],
  ft: ["length", 0.3048],
  in: ["length", 0.0254],
  cm: ["length", 0.01],
  mm: ["length", 0.001],
  "sq m": ["area", 1],
  "sq ft": ["area", 0.09290304],
  "sq yd": ["area", 0.83612736],
  kg: ["weight", 1],
  g: ["weight", 0.001],
  ton: ["weight", 1000],
  litre: ["volume", 1],
  ml: ["volume", 0.001],
};

/** A number in another unit of the same kind ("6 m" → 19.685 ft); null when the units are of different kinds. */
function convert(n: number, from: string, to: string): number | null {
  if (from === "" || from === to) return n;
  const a = SAME_KIND[from];
  const b = SAME_KIND[to];
  if (!a || !b || a[0] !== b[0]) return null;
  return Math.round(((n * a[1]) / b[1]) * 1e4) / 1e4;
}

/**
 * Bounds for a filter read by code alone: at least two values (and 60% of them) are one plain quantity in
 * one measurable unit. A value without a unit ("5001-10000" beside "3000 sq ft") takes the filter's unit.
 * Counts, grades, standards, sizes and anything with an unknown unit are not read.
 */
export function inferRanges(f: FilterRow): ValueRange[] | null {
  const real = f.values.filter((v) => !/^other/i.test(v));
  const read = real.flatMap((v) => {
    const q = readQuantity(v);
    return q ? [{ v, q }] : [];
  });
  if (read.length < 2 || read.length < 0.6 * real.length) return null;
  const counts = new Map<string, number>();
  for (const { q } of read) if (q.key) counts.set(q.key, (counts.get(q.key) ?? 0) + 1);
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!dominant) return null;
  // Values in another unit of the same kind ("6 m" in a filter of feet) are converted into the commonest unit.
  const kept = read.filter(({ q }) => q.key === "" || convert(1, q.key, dominant) !== null);
  if (kept.length < 2 || kept.length < 0.6 * real.length) return null;
  return kept.map(({ v, q }) => ({
    value: v,
    min: q.min === null ? null : convert(q.min, q.key, dominant),
    max: q.max === null ? null : convert(q.max, q.key, dominant),
    unit: displayUnit(dominant),
    ...inclusivityOf(v),
  }));
}

/** Is x inside the range, respecting whether each bound itself counts. */
function holds(r: ValueRange, x: number): boolean {
  const lowOk = r.min === null || (r.min_inclusive === false ? x > r.min : x >= r.min);
  const highOk = r.max === null || (r.max_inclusive === false ? x < r.max : x <= r.max);
  return lowOk && highOk;
}

const keyOfUnit = (unit: string) => unitKey(unit) ?? unit;

function listingFieldOf(f: FilterRow, listing: ListingProfile | null): ListingField | undefined {
  if (!f.linked_listing_spec || !listing) return undefined;
  return listing.fields.find((x) => norm(x.key) === norm(f.linked_listing_spec!));
}

/** Every distinct value of a listing spec read as a quantity (when it is one), with how many listings carry it. */
function listingQuantities(field: ListingField) {
  return (field.all ?? field.top).map(([label, count]) => ({
    label,
    count,
    q: readQuantity(label),
  }));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Edges the model proposed, if each is one of the numbers in the filter's own values (2 to 5, ascending). */
function validEdges(raw: unknown, numbers: number[]): number[] | null {
  if (!Array.isArray(raw)) return null;
  const edges = raw.map((e) => bound(e));
  if (edges.some((e) => typeof e !== "number")) return null;
  const sorted = [...new Set(edges as number[])].sort((a, b) => a - b);
  if (sorted.length < 2 || sorted.length > 5) return null;
  return sorted.every((e) => numbers.some((n) => close(n, e))) ? sorted : null;
}

/**
 * Edges chosen by code when the model proposed none (or bad ones): numbers between the lowest and highest
 * value, at even steps of the listings' own weight, so no bucket is empty or holds nearly everything.
 */
function autoEdges(numbers: number[], weight: (n: number) => number): number[] | null {
  const m = numbers.length;
  if (m < 3) return null;
  const k = Math.min(m - 1, Math.max(2, Math.min(4, Math.round(Math.sqrt(m)))));
  const total = numbers.reduce((s, n) => s + weight(n), 0);
  let cum = 0;
  const at = numbers.map((n) => (cum += weight(n)));
  const edges = new Set<number>();
  for (let i = 1; i <= k; i++) {
    const target = (total * i) / (k + 1);
    const idx = at.findIndex((c) => c >= target);
    const n = numbers[Math.max(idx, 0)]!;
    if (n !== numbers[0] && n !== numbers[m - 1]) edges.add(n);
  }
  // Too few interior edges (3 values): the highest value closes the last bucket.
  for (const n of [numbers[m - 2]!, numbers[m - 1]!]) if (edges.size < 2) edges.add(n);
  return edges.size >= 2 ? [...edges].sort((a, b) => a - b) : null;
}

/** "Less than 2.5 m", "2.5 to 4 m", "4 to 5 m", "More than 5 m". */
function bucketsFor(edges: number[], unit: string): ValueRange[] {
  const k = edges.length;
  const out: ValueRange[] = [
    {
      value: `Less than ${withUnit(edges[0]!, unit)}`,
      min: null,
      max: edges[0]!,
      unit,
      max_inclusive: false,
    },
  ];
  for (let i = 0; i < k - 1; i++) {
    const a = edges[i]!;
    const b = edges[i + 1]!;
    const label =
      unit.startsWith("₹") || !unit
        ? `${withUnit(a, unit)} to ${withUnit(b, unit)}`
        : `${num(a)} to ${num(b)} ${unit}`;
    // Each range holds its lower edge; the top one also holds its upper edge, so the highest value isn't in "More than".
    out.push({
      value: label,
      min: a,
      max: b,
      unit,
      min_inclusive: true,
      max_inclusive: i === k - 2,
    });
  }
  out.push({
    value: `More than ${withUnit(edges[k - 1]!, unit)}`,
    min: edges[k - 1]!,
    max: null,
    unit,
    min_inclusive: false,
  });
  return out;
}

const byLower = (a: ValueRange, b: ValueRange) =>
  (a.min ?? -Infinity) - (b.min ?? -Infinity) || (a.max ?? Infinity) - (b.max ?? Infinity);

/**
 * Exact values ("2.5 m", "4 Meter", "4.5 m", "5 m") become ranges. With ranges among the values, the exact
 * ones are folded into the range that holds them. With only exact values, they become buckets: Less than the
 * first edge, each edge to the next, More than the last. The filter's values are replaced by the new options;
 * the old ones are kept in `exact_values`. Returns whether anything changed.
 */
function regroup(f: FilterRow, rawEdges: unknown, field: ListingField | undefined): boolean {
  const rs = f.ranges!;
  const points = rs.filter(isPoint);
  const spans = rs.filter((r) => !isPoint(r));
  const outside = f.values.filter((v) => !rs.some((r) => r.value === v));
  const unit = rs[0]!.unit;

  if (spans.length && points.length) {
    const lone = points.filter((p) => !spans.some((s) => holds(s, p.min!)));
    const folded = points.filter((p) => !lone.includes(p));
    // Exact values outside every range ("1200 sq ft" beside "500-1000 sq ft") get an open end to live in:
    // "Less than <lowest bound>" and "More than <highest bound>", unless a range there is already open.
    const lowEdge = spans.some((s) => s.min === null)
      ? null
      : Math.min(...spans.map((s) => s.min!));
    const highEdge = spans.some((s) => s.max === null)
      ? null
      : Math.max(...spans.map((s) => s.max!));
    const added: ValueRange[] = [];
    if (
      lone.some(
        (p) => (lowEdge !== null && p.min! < lowEdge) || (highEdge !== null && p.min! > highEdge),
      )
    ) {
      if (lowEdge !== null)
        added.push({
          value: `Less than ${withUnit(lowEdge, unit)}`,
          min: null,
          max: lowEdge,
          unit,
          max_inclusive: false,
        });
      if (highEdge !== null)
        added.push({
          value: `More than ${withUnit(highEdge, unit)}`,
          min: highEdge,
          max: null,
          unit,
          min_inclusive: false,
        });
    }
    // A value in a gap between two ranges still has no range: it stays an exact option.
    const leftover = lone.filter((p) => !added.some((r) => holds(r, p.min!)));
    if (!folded.length && !added.length) return false;
    const kept = [...spans, ...added, ...leftover].sort(byLower);
    f.exact_values = points.filter((p) => !leftover.includes(p)).map((p) => p.value);
    f.ranges = kept;
    f.values = [...kept.map((r) => r.value), ...outside];
    return true;
  }
  if (spans.length) return false;

  const numbers = [...new Set(points.map((p) => p.min!))].sort((a, b) => a - b);
  if (numbers.length < 2) return false;
  const quantities = field ? listingQuantities(field) : [];
  const key = keyOfUnit(unit);
  const weightOf = (n: number) =>
    quantities.reduce((s, x) => {
      const at = x.q && isPoint(x.q) ? convert(x.q.min!, x.q.key, key) : null;
      return s + (at !== null && close(at, n) ? x.count : 0);
    }, 0) || 1;
  // The model's edges may be a number as the value writes it ("13" for "13 Feet") or as converted ("19.685").
  const written = f.values.flatMap((v) => numbersIn(withoutBrackets(v)));
  // Two exact values make two edges: Less than the first, the first to the second, More than the second.
  const edges =
    validEdges(rawEdges, [...numbers, ...written]) ??
    (numbers.length === 2 ? numbers : autoEdges(numbers, weightOf));
  if (!edges) return false;
  const buckets = bucketsFor(edges, unit);
  f.exact_values = points.map((p) => p.value);
  f.ranges = buckets;
  f.values = [...buckets.map((b) => b.value), ...outside];
  return true;
}

/**
 * Ranges that stop at a closed top ("10,001 – 25,000 sq ft") get a "More than 25,000 sq ft" above them; ones
 * that start at a closed bottom get "Less than …" below. A buyer's number can be beyond what the listings show.
 * Returns whether an end was added.
 */
function closeEnds(f: FilterRow): boolean {
  const rs = f.ranges!;
  if (rs.length < 2 || !rs.some((r) => !isPoint(r))) return false;
  const unit = rs[0]!.unit;
  const added: ValueRange[] = [];
  const lows = rs.flatMap((r) => (r.min === null ? [] : [r.min]));
  const highs = rs.flatMap((r) => (r.max === null ? [] : [r.max]));
  if (!rs.some((r) => r.min === null) && lows.length)
    added.push({
      value: `Less than ${withUnit(Math.min(...lows), unit)}`,
      min: null,
      max: Math.min(...lows),
      unit,
      max_inclusive: false,
    });
  if (!rs.some((r) => r.max === null) && highs.length)
    added.push({
      value: `More than ${withUnit(Math.max(...highs), unit)}`,
      min: Math.max(...highs),
      max: null,
      unit,
      min_inclusive: false,
    });
  if (!added.length) return false;
  const all = [...rs, ...added].sort(byLower);
  f.ranges = all;
  f.values = [
    ...all.map((r) => r.value),
    ...f.values.filter((v) => !all.some((r) => r.value === v)),
  ];
  return true;
}

/**
 * The share of listings in each range. A listing value counts once: for the range whose own text it is, else for
 * the first range (lowest bound first) holding it as a single number in the range's unit. Price has no listing
 * spec, so its numbers come from the listings' own prices. A regrouped or price filter also gets its
 * High / Medium / Low per option from that share (its options are new, or have no keyword evidence).
 */
function addFill(
  f: FilterRow,
  field: ListingField | undefined,
  listing: ListingProfile | null,
  rebuilt: boolean,
) {
  const total = listing?.count ?? 0;
  const prices =
    !field && (/price|budget|cost/i.test(f.name) || f.ranges!.some((r) => r.unit.startsWith("₹")))
      ? listing?.price?.values
      : undefined;
  const fromFill = rebuilt || Boolean(f.exact_values?.length) || Boolean(prices);
  if ((!field && !prices) || !total) {
    if (rebuilt || f.exact_values?.length) f.value_confidence = [];
    return;
  }
  const ranges = [...f.ranges!].sort(byLower);
  const counts = new Map<ValueRange, number>(ranges.map((r) => [r, 0]));
  const add = (r: ValueRange, n: number) => counts.set(r, (counts.get(r) ?? 0) + n);
  const filled = prices ? prices.length : field!.filled;
  const label = prices ? "price" : field!.key;

  if (prices) {
    for (const p of prices) {
      const r = ranges.find((x) => holds(x, p));
      if (r) add(r, 1);
    }
  } else {
    for (const x of listingQuantities(field!)) {
      const own = ranges.find((r) => norm(r.value) === norm(x.label));
      if (own) {
        add(own, x.count);
        continue;
      }
      if (!x.q || !isPoint(x.q)) continue;
      const r = ranges.find((c) => {
        const at = convert(x.q!.min!, x.q!.key, keyOfUnit(c.unit));
        return at !== null && holds(c, at);
      });
      if (r) add(r, x.count);
    }
  }

  const conf: ValueConfidence[] = [];
  for (const r of f.ranges!) {
    const n = Math.min(counts.get(r) ?? 0, filled);
    r.listings = n;
    r.fill_pct = round1((n / total) * 100);
    if (fromFill) {
      const share = filled ? (n / filled) * 100 : 0;
      conf.push({
        value: r.value,
        level: share >= HIGH_AT ? "High" : share >= MEDIUM_AT ? "Medium" : "Low",
        why: `${round1(share)}% of the listings that have a ${label} (${n} of ${filled}) · ${r.fill_pct}% of all ${total} listings`,
      });
    }
  }
  if (fromFill) f.value_confidence = conf;
}
