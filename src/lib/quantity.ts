/*
 * Measurements in ISQ values (skill 15): Area, Size, Length, Width, Height and the like, and machine figures —
 * Capacity, Output, Power, Weight, Volume. A value is read as a quantity — a length ("20 ft"), an area
 * ("500 sq ft"), a size of 2–3 axes ("10 x 12 ft"), a weight ("50 kg"), a volume ("500 L"), a power rating
 * ("5 kW", "2 HP"), a rate ("100 kg/hr", "500 L/day") or a range of one of those ("Up to 500 sq ft",
 * "50 - 100 kg/hr", "Above 1000 sq ft") — and written back in one spelling, so "20ft", "20 Feet" and "20 FT." are
 * one value. Anything that isn't a quantity ("as per requirement", "1 BHK", "Other") is not one, and the
 * measurement check drops it. Units are never converted: a value in another unit than its ISQ's ("2 HP" under
 * kW, "6500 kg/day" under kg/hr) is left out, not recalculated.
 */

export type QuantityKind =
  "length" | "area" | "dims" | "weight" | "volume" | "power" | "rate" | "bare";
export type QuantityRange = "" | "upto" | "above" | "between";

/** The kind a unit gives a single number. */
type UnitKind = Exclude<QuantityKind, "dims" | "bare">;

export interface Quantity {
  /** "bare" is a number with no unit ("20"): it takes its ISQ's kind and unit. */
  kind: QuantityKind;
  /**
   * "ft", "m", "mm", "cm", "inch", "sq ft", "sq m", "acre", "sq yd", "hectare", "kg", "g", "ton", "L", "ml",
   * "kW", "HP", "W", a rate such as "kg/hr", "L/day" or "pcs/min", or "" when none is written.
   */
  unit: string;
  /** The axes of a size, the one number of a single quantity, or the low and high end of a range. */
  nums: number[];
  range: QuantityRange;
}

const NUM = String.raw`\d+(?:\.\d+)?`;
const AREA_UNIT = String.raw`sq\.?\s*(?:ft|feet|foot|fts)\.?|sqft|sft|square\s*(?:feet|foot|ft)|sq\.?\s*(?:mtrs?|met(?:er|re)s?|mt|m)\.?|sqmtr?|sqmt|sqm|square\s*met(?:er|re)s?|acres?|hectares?|sq\.?\s*(?:yards?|yds?)|square\s*yards?|gaj`;
const LENGTH_UNIT = String.raw`ft\.?|feet|foot|fts|'|mm|cm|mtrs?\.?|met(?:er|re)s?|m|inch(?:es)?|in|"`;
const WEIGHT_UNIT = String.raw`kgs?|kilo(?:gram)?s?|grams?|gms?|g|tonnes?|tons?`;
const VOLUME_UNIT = String.raw`ltrs?|lit(?:re|er)s?|lit|lt|l|ml|millilit(?:re|er)s?`;
const POWER_UNIT = String.raw`kw|kilowatts?|hp|horse\s*power|watts?|w`;
const COUNT_UNIT = String.raw`pcs|pieces?|nos`;
const TIME_UNIT = String.raw`min(?:ute)?s?|h|hrs?|hours?|shifts?|days?`;
/** "kg/hr", "L per day", "pcs/min", and the short forms LPH, LPD, TPH, TPD. */
const RATE_UNIT = String.raw`(?:${WEIGHT_UNIT}|${VOLUME_UNIT}|${COUNT_UNIT})\s*(?:\/|per)\s*(?:${TIME_UNIT})|lph|lpd|tph|tpd`;
const UNIT = `(?:${RATE_UNIT}|${AREA_UNIT}|${LENGTH_UNIT}|${WEIGHT_UNIT}|${VOLUME_UNIT}|${POWER_UNIT})`;

const UNIT_LABELS: [RegExp, string, UnitKind][] = [
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
  [/^(kgs?|kilo(gram)?s?)$/, "kg", "weight"],
  [/^(grams?|gms?|g)$/, "g", "weight"],
  [/^(tonnes?|tons?)$/, "ton", "weight"],
  [/^(ltrs?|lit(re|er)s?|lit|lt|l)$/, "L", "volume"],
  [/^(ml|millilit(re|er)s?)$/, "ml", "volume"],
  [/^(kw|kilowatts?)$/, "kW", "power"],
  [/^(hp|horse ?power)$/, "HP", "power"],
  [/^(watts?|w)$/, "W", "power"],
  [/^(pcs|pieces?|nos)$/, "pcs", "rate"],
];

const TIME_LABELS: [RegExp, string][] = [
  [/^min(ute)?s?$/, "min"],
  [/^(h|hrs?|hours?)$/, "hr"],
  [/^shifts?$/, "shift"],
  [/^days?$/, "day"],
];

const SHORT_RATES: Record<string, string> = {
  lph: "L/hr",
  lpd: "L/day",
  tph: "ton/hr",
  tpd: "ton/day",
};

/** A rate's one spelling ("Kg Per Hour" → "kg/hr"), or null when the text isn't a rate. */
function rateOf(u: string): string | null {
  if (SHORT_RATES[u]) return SHORT_RATES[u]!;
  const m = u.match(/^(.+?) ?(?:\/|per) ?(.+)$/);
  if (!m) return null;
  const base = UNIT_LABELS.find(
    ([re, , kind]) => re.test(m[1]!) && (kind === "weight" || kind === "volume" || kind === "rate"),
  );
  const time = TIME_LABELS.find(([re]) => re.test(m[2]!));
  return base && time ? `${base[1]}/${time[1]}` : null;
}

function unitOf(raw: string | undefined): { unit: string; kind: UnitKind } | null | "" {
  const u = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!u) return "";
  const rate = rateOf(u);
  if (rate) return { unit: rate, kind: "rate" };
  // "pcs" alone is a count, not a rate: only "pcs/hr" and the like are quantities.
  for (const [re, unit, kind] of UNIT_LABELS)
    if (re.test(u)) return kind === "rate" ? null : { unit, kind };
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
function oneUnit(raw: (string | undefined)[]): { unit: string; kind: UnitKind | "" } | null {
  let out: { unit: string; kind: UnitKind | "" } = { unit: "", kind: "" };
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
    // A size is made of lengths: "10 x 10 sq ft" or "2 x 50 kg" is not one.
    if (!u || (u.kind && u.kind !== "length")) return null;
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

/**
 * What a measurement ISQ holds, from its name: an area, one length, or a size (which can be either, or axes);
 * or a machine figure — a capacity (a rate, a volume or a weight), a weight, a volume or a power rating.
 */
export type MeasureKind = "area" | "length" | "size" | "capacity" | "weight" | "volume" | "power";

const AREA_NAME = /\barea\b/i;
const LENGTH_NAME = /\b(length|width|breadth|height|thickness|diameter|depth|span)\b/i;
const SIZE_NAME = /\b(size|dimensions?)\b/i;
const CAPACITY_NAME = /\b(capacity|output|throughput)\b/i;
const POWER_NAME = /\b(power|wattage)\b/i;
const WEIGHT_NAME = /\b(weight|load)\b/i;
const VOLUME_NAME = /\bvolume\b/i;
/** A machine-figure word that names a choice, not a number: "Power Source", "Power Supply", "Load Type". */
const NOT_A_FIGURE =
  /\b(type|source|supply|mode|method|grade|material|phase|system|backup|factor)\b/i;

export function measureKind(name: string): MeasureKind | null {
  if (AREA_NAME.test(name)) return "area";
  if (LENGTH_NAME.test(name)) return "length";
  if (SIZE_NAME.test(name)) return "size";
  if (NOT_A_FIGURE.test(name)) return null;
  if (CAPACITY_NAME.test(name)) return "capacity";
  if (POWER_NAME.test(name)) return "power";
  if (WEIGHT_NAME.test(name)) return "weight";
  if (VOLUME_NAME.test(name)) return "volume";
  return null;
}

/** An area, length or size: the measurements made of feet and metres, as opposed to machine figures. */
export const isSpatial = (measure: MeasureKind) =>
  measure === "area" || measure === "length" || measure === "size";

/** The shape every value of a measurement ISQ must have: one kind, one unit, and for sizes one number of axes. */
export interface QuantityShape {
  kind: Exclude<QuantityKind, "bare">;
  unit: string;
  axes: number;
}

const KIND_NAME: Record<Exclude<QuantityKind, "bare">, string> = {
  length: "a length",
  area: "an area",
  dims: "a size",
  weight: "a weight",
  volume: "a volume",
  power: "a power rating",
  rate: "a rate",
};

/** "a length", "an area", "a rate"…: what a value of this kind is, for notes. */
export const kindName = (kind: Exclude<QuantityKind, "bare">) => KIND_NAME[kind];

/** "lengths", "power ratings"…: values of this kind, for notes. */
export const KIND_PLURAL: Record<Exclude<QuantityKind, "bare">, string> = {
  length: "lengths",
  area: "areas",
  dims: "sizes",
  weight: "weights",
  volume: "volumes",
  power: "power ratings",
  rate: "rates",
};

/**
 * The figures inside a text value: each number with a unit in it ("0.5 kW Electric" → 0.5 kW, "Up to 200 kg
 * per batch" → 200 kg). Counts and codes are not figures: "2 Seater", "4 Trays", "SS 304", "G+1", "3 Phase".
 */
export function figuresIn(text: string): Quantity[] {
  const out: Quantity[] = [];
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?\s*[a-z"']+(?:\s*(?:\/|per)\s*[a-z]+)?/gi)) {
    // Longest first: "100 kg/hr" before "100 kg".
    const words = m[0];
    const q = parseQuantity(words) ?? parseQuantity(words.replace(/\s*(?:\/|per)\s*[a-z]+$/i, ""));
    if (q && q.kind !== "bare") out.push(q);
  }
  return out;
}

/** What an ISQ of this measure holds, plural, for notes: "areas", "capacities". */
export const MEASURE_PLURAL: Record<MeasureKind, string> = {
  area: "areas",
  length: "lengths",
  size: "sizes",
  capacity: "capacities",
  weight: "weights",
  volume: "volumes",
  power: "power ratings",
};

/**
 * How many numbers a value may have, by what the ISQ is: a Length, Width or Height is always one number; an
 * Area or a Size is one ("500 sq ft"), two ("20 x 10 ft") or three ("20 x 10 x 8 ft"), whichever the category
 * document (or, without one, the data) uses.
 */
const ALLOWED: Record<MeasureKind, QuantityKind[]> = {
  area: ["area", "dims"],
  length: ["length"],
  size: ["dims", "length", "area"],
  capacity: ["rate", "volume", "weight"],
  weight: ["weight"],
  volume: ["volume"],
  power: ["power"],
};

/**
 * A quantity counts towards an ISQ being this measurement: a bare number always; for an area, length or size any
 * length, area or size (a size under Length gives one axis); for a machine figure only the kinds it takes.
 */
export function countsFor(q: Quantity, measure: MeasureKind): boolean {
  if (q.kind === "bare") return true;
  if (isSpatial(measure)) return q.kind === "length" || q.kind === "area" || q.kind === "dims";
  return ALLOWED[measure].includes(q.kind);
}

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
      kind: q.kind,
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
  if (q.kind === "dims") return `a size, not ${KIND_NAME[shape.kind]}`;
  if (q.kind !== "bare" && q.kind !== shape.kind)
    return `${KIND_NAME[q.kind]}, not ${KIND_NAME[shape.kind]}`;
  if (q.unit && q.unit !== shape.unit) return `in ${q.unit}, not ${shape.unit}`;
  return { ...q, kind: shape.kind, unit: shape.unit };
}
