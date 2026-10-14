/*
 * Measurements in ISQ values (skill 15): Area, Size, Length, Width, Height and the like. A value is read as a
 * quantity — a length ("20 ft"), an area ("500 sq ft"), a size of 2–3 axes ("10 x 12 ft") or a range of one of
 * those ("Up to 500 sq ft", "500 - 1000 sq ft", "Above 1000 sq ft") — and written back in one spelling, so
 * "20ft", "20 Feet" and "20 FT." are one value. Anything that isn't a quantity ("as per requirement", "1 BHK",
 * "Other") is not one, and the measurement check drops it. Units are never converted: a value in another unit
 * than its ISQ's is left out, not recalculated.
 */

export type QuantityKind = "length" | "area" | "dims" | "bare";
export type QuantityRange = "" | "upto" | "above" | "between";

export interface Quantity {
  /** "bare" is a number with no unit ("20"): it takes its ISQ's kind and unit. */
  kind: QuantityKind;
  /** "ft", "m", "mm", "cm", "inch", "sq ft", "sq m", "acre", "sq yd", "hectare", or "" when none is written. */
  unit: string;
  /** The axes of a size, the one number of a length or area, or the low and high end of a range. */
  nums: number[];
  range: QuantityRange;
}

const NUM = String.raw`\d+(?:\.\d+)?`;
const AREA_UNIT = String.raw`sq\.?\s*(?:ft|feet|foot|fts)\.?|sqft|sft|square\s*(?:feet|foot|ft)|sq\.?\s*(?:mtrs?|met(?:er|re)s?|mt|m)\.?|sqmtr?|sqmt|sqm|square\s*met(?:er|re)s?|acres?|hectares?|sq\.?\s*(?:yards?|yds?)|square\s*yards?|gaj`;
const LENGTH_UNIT = String.raw`ft\.?|feet|foot|fts|'|mm|cm|mtrs?\.?|met(?:er|re)s?|m|inch(?:es)?|in|"`;
const UNIT = `(?:${AREA_UNIT}|${LENGTH_UNIT})`;

const UNIT_LABELS: [RegExp, string, "length" | "area"][] = [
  [/^(sq\.?\s*(ft|feet|foot|fts)\.?|sqft|sft|square\s*(feet|foot|ft))$/, "sq ft", "area"],
  [
    /^(sq\.?\s*(mtrs?|met(er|re)s?|mt|m)\.?|sqmtr?|sqmt|sqm|square\s*met(er|re)s?)$/,
    "sq m",
    "area",
  ],
  [/^acres?$/, "acre", "area"],
  [/^hectares?$/, "hectare", "area"],
  [/^(sq\.?\s*(yards?|yds?)|square\s*yards?|gaj)$/, "sq yd", "area"],
  [/^(ft\.?|feet|foot|fts|')$/, "ft", "length"],
  [/^mm$/, "mm", "length"],
  [/^cm$/, "cm", "length"],
  [/^(mtrs?\.?|met(er|re)s?|m)$/, "m", "length"],
  [/^(inch(es)?|in|")$/, "inch", "length"],
];

function unitOf(raw: string | undefined): { unit: string; kind: "length" | "area" } | null | "" {
  const u = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!u) return "";
  for (const [re, unit, kind] of UNIT_LABELS) if (re.test(u)) return { unit, kind };
  return null;
}

const UPTO = String.raw`(?:up\s*to|upto|under|below|less\s*than|within|max(?:imum)?\.?|<=?|≤)`;
const ABOVE = String.raw`(?:above|over|more\s*than|greater\s*than|min(?:imum)?\.?|>=?|≥)`;
const AND_UP = String.raw`(?:\+|and\s*above|&\s*above|or\s*more|onwards)`;

const RE_UPTO = new RegExp(`^${UPTO}\\s*(${NUM})\\s*(${UNIT})?$`);
const RE_ABOVE = new RegExp(`^${ABOVE}\\s*(${NUM})\\s*(${UNIT})?$`);
const RE_AND_UP = new RegExp(`^(${NUM})\\s*(${UNIT})?\\s*${AND_UP}$`);
/** "2500+ sq ft": the plus before the unit. */
const RE_PLUS = new RegExp(`^(${NUM})\\s*\\+\\s*(${UNIT})?$`);
const RE_BETWEEN = new RegExp(`^(${NUM})\\s*(${UNIT})?\\s*(?:-|–|—|to)\\s*(${NUM})\\s*(${UNIT})?$`);
const RE_DIMS = new RegExp(
  `^(${NUM})\\s*(${UNIT})?\\s*x\\s*(${NUM})\\s*(${UNIT})?(?:\\s*x\\s*(${NUM})\\s*(${UNIT})?)?$`,
);
const RE_SINGLE = new RegExp(`^(${NUM})\\s*(${UNIT})?$`);

/** One unit for a quantity written with several ("10 ft x 12 ft"): they must agree; blanks take the others'. */
function oneUnit(
  raw: (string | undefined)[],
): { unit: string; kind: "length" | "area" | "" } | null {
  let out: { unit: string; kind: "length" | "area" | "" } = { unit: "", kind: "" };
  for (const r of raw) {
    const u = unitOf(r);
    if (u === null) return null;
    if (u === "") continue;
    if (out.unit && out.unit !== u.unit) return null;
    out = u;
  }
  return out;
}

/** A value as a quantity, or null when it isn't one. */
export function parseQuantity(text: string): Quantity | null {
  let t = text
    .toLowerCase()
    // Commas inside a number go, in thousands ("5,000") and in the Indian lakh form ("1,00,000").
    .replace(/(\d),(?=\d{2,3}(?!\d))/g, "$1")
    .replace(/[×*]/g, "x")
    .replace(/\s+/g, " ")
    .trim();
  // "25 ft (7.5 m)" is 25 ft; "Size (10 x 10 ft)" is 10 x 10 ft.
  const paren = t.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (paren) {
    const [, outside = "", inside = ""] = paren;
    t = /\d/.test(outside) ? outside.trim() : /\d/.test(inside) ? inside.trim() : t;
  }
  t = t.replace(/\.$/, "").trim();
  if (!/\d/.test(t)) return null;

  const single = (
    m: RegExpMatchArray | null,
    range: QuantityRange,
  ): Quantity | null | undefined => {
    if (!m) return undefined;
    const u = oneUnit([m[2]]);
    if (!u) return null;
    return { kind: u.kind || "bare", unit: u.unit, nums: [Number(m[1])], range };
  };
  for (const [re, range] of [
    [RE_UPTO, "upto"],
    [RE_ABOVE, "above"],
    [RE_AND_UP, "above"],
    [RE_PLUS, "above"],
  ] as const) {
    const q = single(t.match(re), range);
    if (q !== undefined) return q;
  }

  const between = t.match(RE_BETWEEN);
  if (between) {
    const u = oneUnit([between[2], between[4]]);
    const lo = Number(between[1]);
    const hi = Number(between[3]);
    if (!u || hi <= lo) return null;
    return { kind: u.kind || "bare", unit: u.unit, nums: [lo, hi], range: "between" };
  }

  const dims = t.match(RE_DIMS);
  if (dims) {
    const u = oneUnit([dims[2], dims[4], dims[6]]);
    // A size is made of lengths: "10 x 10 sq ft" is not one.
    if (!u || u.kind === "area") return null;
    const nums = [dims[1], dims[3], dims[5]].filter((n) => n !== undefined).map(Number);
    return { kind: "dims", unit: u.unit, nums, range: "" };
  }

  const one = single(t.match(RE_SINGLE), "");
  return one ?? null;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** The one spelling of a quantity: "10 x 12 ft", "20 ft", "Up to 500 sq ft", "500 - 1000 sq ft", "Above 1000 sq ft". */
export function formatQuantity(q: Quantity): string {
  const unit = q.unit ? ` ${q.unit}` : "";
  if (q.range === "upto") return `Up to ${fmt(q.nums[0]!)}${unit}`;
  if (q.range === "above") return `Above ${fmt(q.nums[0]!)}${unit}`;
  if (q.range === "between") return `${fmt(q.nums[0]!)} - ${fmt(q.nums[1]!)}${unit}`;
  return `${q.nums.map(fmt).join(" x ")}${unit}`;
}

/** Two values are the same quantity when their keys are equal. */
export const quantityKey = (q: Quantity) =>
  `${q.kind}|${q.range}|${q.unit}|${q.nums.map(fmt).join("x")}`;

/** What a measurement ISQ holds, from its name: an area, one length, or a size (which can be either, or axes). */
export type MeasureKind = "area" | "length" | "size";

const AREA_NAME = /\barea\b/i;
const LENGTH_NAME = /\b(length|width|breadth|height|thickness|diameter|depth|span)\b/i;
const SIZE_NAME = /\b(size|dimensions?)\b/i;

export function measureKind(name: string): MeasureKind | null {
  if (AREA_NAME.test(name)) return "area";
  if (LENGTH_NAME.test(name)) return "length";
  if (SIZE_NAME.test(name)) return "size";
  return null;
}

/** The shape every value of a measurement ISQ must have: one kind, one unit, and for sizes one number of axes. */
export interface QuantityShape {
  kind: "length" | "area" | "dims";
  unit: string;
  axes: number;
}

/**
 * How many numbers a value may have, by what the ISQ is: a Length, Width or Height is always one number; an
 * Area or a Size is one ("500 sq ft"), two ("20 x 10 ft") or three ("20 x 10 x 8 ft"), whichever the category
 * document (or, without one, the data) uses.
 */
const ALLOWED: Record<MeasureKind, QuantityKind[]> = {
  area: ["area", "dims"],
  length: ["length"],
  size: ["dims", "length", "area"],
};

/** Which number of a size a one-number ISQ is: Length the first, Width the second, Height the third. */
export function axisOf(name: string): number | undefined {
  if (/\blength\b/i.test(name)) return 0;
  if (/\b(width|breadth)\b/i.test(name)) return 1;
  if (/\bheight\b/i.test(name)) return 2;
  return undefined;
}

/**
 * The commonest shape among quantities (each with a weight), restricted to what the ISQ's name allows. Values
 * with no unit count towards their kind but never decide the unit. null when nothing fits.
 */
export function dominantShape(
  items: { q: Quantity; weight: number }[],
  measure: MeasureKind,
): QuantityShape | null {
  const totals = new Map<string, { shape: QuantityShape; weight: number }>();
  for (const { q, weight } of items) {
    if (q.kind === "bare" || !q.unit || !ALLOWED[measure].includes(q.kind)) continue;
    const shape: QuantityShape = {
      kind: q.kind as QuantityShape["kind"],
      unit: q.unit,
      axes: q.kind === "dims" ? q.nums.length : 1,
    };
    const key = `${shape.kind}|${shape.unit}|${shape.axes}`;
    const t = totals.get(key) ?? { shape, weight: 0 };
    t.weight += weight;
    totals.set(key, t);
  }
  let best: { shape: QuantityShape; weight: number } | null = null;
  for (const t of totals.values()) if (!best || t.weight > best.weight) best = t;
  return best?.shape ?? null;
}

/**
 * A quantity made to fit its ISQ's shape, or the reason it can't: a value with no unit takes the ISQ's; a
 * 3-axis size keeps its first two axes when the ISQ's sizes are length x width; a size under a one-number ISQ
 * gives the number of that axis (`axis`); another unit or kind doesn't fit.
 */
export function conform(q: Quantity, shape: QuantityShape, axis?: number): Quantity | string {
  // A whole size under Length, Width or Height ("20 x 10 ft" under Length) gives that one number.
  if (
    shape.kind === "length" &&
    q.kind === "dims" &&
    axis !== undefined &&
    q.nums[axis] !== undefined
  ) {
    if (q.unit && q.unit !== shape.unit) return `in ${q.unit}, not ${shape.unit}`;
    return { kind: "length", unit: shape.unit, nums: [q.nums[axis]!], range: "" };
  }
  if (shape.kind === "dims") {
    if (q.kind !== "dims") return "not a size";
    if (q.unit && q.unit !== shape.unit) return `in ${q.unit}, not ${shape.unit}`;
    if (q.nums.length < shape.axes) return `${q.nums.length} axes, not ${shape.axes}`;
    return { ...q, unit: shape.unit, nums: q.nums.slice(0, shape.axes) };
  }
  if (q.kind === "dims") return `a size, not ${shape.kind === "area" ? "an area" : "a length"}`;
  if (q.kind !== "bare" && q.kind !== shape.kind)
    return `${q.kind === "area" ? "an area" : "a length"}, not ${shape.kind === "area" ? "an area" : "a length"}`;
  if (q.unit && q.unit !== shape.unit) return `in ${q.unit}, not ${shape.unit}`;
  return { ...q, kind: shape.kind, unit: shape.unit };
}
