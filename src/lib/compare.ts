import type { FilterResult, Tier } from "./filter-gen";

const STOP = new Set(["of", "and", "the", "type", "types", "for", "in", "a", "isq"]);

/** Lower-case word stems of a filter / ISQ name, so "Material Type" ≈ "materials". */
function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOP.has(t))
    .map((t) => (t.length > 3 ? t.replace(/(es|s)$/, "") : t));
}

/** 0–1: how alike two names are (shared words over all words; 1 when one holds the other). */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  const shared = [...ta].filter((t) => tb.has(t)).length;
  if (shared === ta.size || shared === tb.size) return 1;
  return shared / (ta.size + tb.size - shared);
}

const MATCH_AT = 0.5;

interface Pair {
  a: number;
  b: number;
}

/** Greedy one-to-one matching of two name lists, best pairs first. */
function match(as: string[], bs: string[]): Pair[] {
  const cand: (Pair & { s: number })[] = [];
  as.forEach((x, a) =>
    bs.forEach((y, b) => {
      const s = nameSimilarity(x, y);
      if (s >= MATCH_AT) cand.push({ a, b, s });
    }),
  );
  cand.sort((p, q) => q.s - p.s);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const out: Pair[] = [];
  for (const c of cand) {
    if (usedA.has(c.a) || usedB.has(c.b)) continue;
    usedA.add(c.a);
    usedB.add(c.b);
    out.push({ a: c.a, b: c.b });
  }
  return out;
}

export interface RefCoverage {
  reference: number;
  covered: string[];
  missed: string[];
  /** Filters that match no reference ISQ (new ISQ the run proposes). */
  extra: string[];
}

export interface ContextComparison {
  /** Filters both runs produced, with the tier each gave it. */
  shared: { without: string; withCtx: string; tierWithout: Tier; tierWith: Tier }[];
  onlyWithout: string[];
  onlyWith: string[];
  /** shared ÷ all distinct filters across both runs, 0–100. */
  overlapPct: number;
  /** Shared filters that got the same tier in both runs, 0–100. */
  sameTierPct: number;
  /** Share of the with-context filters the without-context run also found, 0–100. */
  recallPct: number;
  refWithout: RefCoverage | null;
  refWith: RefCoverage | null;
}

function coverage(filters: string[], reference: string[]): RefCoverage {
  const pairs = match(reference, filters);
  const hitRef = new Set(pairs.map((p) => p.a));
  const hitFilter = new Set(pairs.map((p) => p.b));
  return {
    reference: reference.length,
    covered: reference.filter((_, i) => hitRef.has(i)),
    missed: reference.filter((_, i) => !hitRef.has(i)),
    extra: filters.filter((_, i) => !hitFilter.has(i)),
  };
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

/** How close the filters (ISQs) are with and without the category context, and vs the ISQs you gave. */
export function compareContext(
  without: FilterResult,
  withCtx: FilterResult,
  referenceIsq: string[],
): ContextComparison {
  const a = without.filters;
  const b = withCtx.filters;
  const pairs = match(
    a.map((f) => f.name),
    b.map((f) => f.name),
  );
  const shared = pairs.map((p) => ({
    without: a[p.a]!.name,
    withCtx: b[p.b]!.name,
    tierWithout: a[p.a]!.tier,
    tierWith: b[p.b]!.tier,
  }));
  const usedA = new Set(pairs.map((p) => p.a));
  const usedB = new Set(pairs.map((p) => p.b));
  return {
    shared,
    onlyWithout: a.filter((_, i) => !usedA.has(i)).map((f) => f.name),
    onlyWith: b.filter((_, i) => !usedB.has(i)).map((f) => f.name),
    overlapPct: pct(shared.length, a.length + b.length - shared.length),
    sameTierPct: pct(shared.filter((s) => s.tierWithout === s.tierWith).length, shared.length),
    recallPct: pct(shared.length, b.length),
    refWithout: referenceIsq.length
      ? coverage(
          a.map((f) => f.name),
          referenceIsq,
        )
      : null,
    refWith: referenceIsq.length
      ? coverage(
          b.map((f) => f.name),
          referenceIsq,
        )
      : null,
  };
}

/** The ISQ names you gave: one per line / comma, numbering and bullets stripped. */
export function parseReferenceIsq(specs: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of specs.split(/[\n,;|]/)) {
    const name = raw
      .replace(/^\s*[-•*]?\s*\d+\s*[-.)]\s*/, "")
      .replace(/\s*(:|\(|\s[-–—]\s).*$/, "")
      .trim();
    const key = name.toLowerCase();
    if (name.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Whether the result carries UI patterns. Runs made with "Include UI design" off don't; their
 * options (ISQ values) are still there and still shown.
 */
export function resultHasDesign(result: FilterResult | null | undefined) {
  return Boolean(result?.filters.some((f) => f.ui_pattern && f.ui_pattern !== "display only"));
}

const cell = (v: string) => v.replace(/\|/g, "\\|");
const list = (names: string[]) => (names.length ? names.map(cell).join(", ") : "none");

/** The with/without-context comparison as a markdown section for a saved .md. */
export function comparisonMarkdown(cmp: ContextComparison): string {
  const lines = [
    "## With vs without category context",
    "",
    `- **Overlap:** ${cmp.overlapPct}% (${cmp.shared.length} filters in both runs)`,
    `- **Found without context:** ${cmp.recallPct}% of the with-context filters`,
    `- **Same tier:** ${cmp.shared.length ? `${cmp.sameTierPct}%` : "n/a"} of shared filters`,
    `- **Only with context:** ${list(cmp.onlyWith)}`,
    `- **Only without context:** ${list(cmp.onlyWithout)}`,
  ];
  const refs: [string, RefCoverage | null][] = [
    ["with context", cmp.refWith],
    ["without context", cmp.refWithout],
  ];
  for (const [label, ref] of refs) {
    if (!ref) continue;
    lines.push(
      "",
      `**Against the ISQs you gave, ${label}:** ${ref.covered.length}/${ref.reference} found`,
      `- Missed: ${list(ref.missed)}`,
      `- Extra: ${list(ref.extra)}`,
    );
  }
  if (cmp.shared.length) {
    lines.push("", "| Without context | Tier | With context | Tier |", "|---|---|---|---|");
    for (const x of cmp.shared)
      lines.push(`| ${cell(x.without)} | ${x.tierWithout} | ${cell(x.withCtx)} | ${x.tierWith} |`);
  }
  return `${lines.join("\n")}\n`;
}
