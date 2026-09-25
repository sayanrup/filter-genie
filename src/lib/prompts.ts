import {
  SOURCE_LABEL,
  type Aggregation,
  type KeywordTable,
  type ListingProfile,
  type TermMining,
  type TermStat,
  type DimensionCandidates,
  type specSummary,
} from "./data";
import { composeSystemPrompt } from "@/skills";

/*
 * System prompts are assembled from the skill docs in src/skills (base.md + one .md per layer).
 * This file only builds the per-run USER messages — the data blocks the model reads:
 *   1. term labelling    — mined keyword terms (the ones code couldn't label itself)
 *   2. field mapping     — canonical spec names to merge or drop
 *   3. filter design     — the computed evidence (dimension tables, context, ranking, listing profile)
 * All numbers the model sees in step 3 are computed by code, so it never has to add anything up.
 * Every block is kept as small as it can be: input tokens are the bulk of a run's cost.
 */

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const pctStr = (n: number) => `${n}%`;

/** Wrap untrusted user data so the model treats it as data, not instructions. */
function block(label: string, body: string) {
  return `<<<${label}\n${body.trim()}\n${label}>>>`;
}

/** Trim long text on a line break and collapse runs of blank lines / spaces (they cost tokens). */
function clip(text: string, max: number) {
  const t = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  if (t.length <= max) return t;
  const cut = t.lastIndexOf("\n", max);
  return `${t.slice(0, cut > max * 0.7 ? cut : max)}\n[… truncated — ${fmt(t.length - max)} more characters not shown]`;
}

/**
 * How much of each input goes into a prompt. "normal" is used first; "compact" is the automatic
 * retry when a provider says the prompt is too long for the model (small-context providers).
 */
export interface PromptBudget {
  /** Characters of the context doc (relevance-picked excerpt) in the design / labelling prompts. */
  contextChars: number;
  labelContextChars: number;
  rankingChars: number;
  /** Values per keyword dimension, and whether rate columns (CTR, conversion) are included. */
  maxValues: number;
  rates: boolean;
  topKeywords: number;
  rawTerms: number;
  /** Listing specs shown with values, values per spec and characters per value. */
  maxSpecs: number;
  specValues: number;
  valueChars: number;
  /** Terms sent for labelling and spec names sent for merging. */
  labelTerms: number;
  fieldSpecs: number;
}

export const BUDGETS: Record<"normal" | "compact", PromptBudget> = {
  normal: {
    contextChars: 4500,
    labelContextChars: 1200,
    rankingChars: 1500,
    maxValues: 8,
    rates: true,
    topKeywords: 8,
    rawTerms: 60,
    maxSpecs: 25,
    specValues: 4,
    valueChars: 24,
    labelTerms: 150,
    fieldSpecs: 60,
  },
  compact: {
    contextChars: 1800,
    labelContextChars: 0,
    rankingChars: 800,
    maxValues: 5,
    rates: false,
    topKeywords: 5,
    rawTerms: 30,
    maxSpecs: 12,
    specValues: 3,
    valueChars: 20,
    labelTerms: 80,
    fieldSpecs: 30,
  },
};

const DECISION_WORDS =
  /\b(buyer|buyers|choose|choice|decide|decision|filter|important|priority|prefer|ask|asks|must|need|spec|specification|ignore|missing|compare|budget|price|size|material|type|quality)\b/gi;

/**
 * Pick the parts of a long context doc that matter for filter design: paragraphs that name the
 * category's dimensions or talk about how buyers decide. Kept in document order, within `max`.
 */
export function excerpt(text: string, max: number, keywords: string[]) {
  const t = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  if (max <= 0) return "";
  if (t.length <= max) return t;
  // Chunks of ≤ ~400 characters on line breaks.
  const chunks: string[] = [];
  let cur = "";
  for (const line of t.split("\n")) {
    if (cur && cur.length + line.length > 400) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) chunks.push(cur);
  const kws = [
    ...new Set(keywords.map((k) => k.toLowerCase().trim()).filter((k) => k.length >= 3)),
  ];
  const scored = chunks.map((c, i) => {
    const low = c.toLowerCase();
    const hits = kws.reduce((n, k) => n + (low.includes(k) ? 1 : 0), 0);
    const decision = (c.match(DECISION_WORDS) ?? []).length;
    return { i, c, score: hits * 3 + Math.min(decision, 6) + (i === 0 ? 4 : 0) };
  });
  const picked = new Set<number>();
  let used = 0;
  for (const x of [...scored].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (used + x.c.length > max) continue;
    picked.add(x.i);
    used += x.c.length + 1;
  }
  const out: string[] = [];
  let last = -1;
  for (const x of scored) {
    if (!picked.has(x.i)) continue;
    if (x.i !== last + 1) out.push("[…]");
    out.push(x.c);
    last = x.i;
  }
  if (last !== chunks.length - 1) out.push("[…]");
  return `${out.join("\n")}\n[excerpt: ${fmt(used)} of ${fmt(t.length)} characters, the parts most relevant to buyer choice and this category's specs]`;
}

// ───────────────────────────── 1 · term labelling ─────────────────────────────

export const TERM_LABEL_SYSTEM = composeSystemPrompt("label");

export function buildTermLabelUser(
  terms: TermStat[],
  mining: TermMining,
  dims: DimensionCandidates,
  context: string,
  budget: PromptBudget = BUDGETS.normal,
) {
  // No numbers: labelling doesn't need them. Skip the example when it's just the term itself.
  const lines = terms
    .slice(0, budget.labelTerms)
    .map((t) => (t.example.toLowerCase().trim() === t.term ? t.term : `${t.term} | ${t.example}`));
  const dimLines: string[] = [];
  if (dims.ranking.length)
    dimLines.push(`CM ranking (most important first): ${dims.ranking.join(", ")}`);
  if (dims.listing.length)
    dimLines.push(
      "Listing specs (name — common values):",
      ...dims.listing
        .slice(0, budget.maxSpecs)
        .map((d) => `${d.name} — ${d.values.slice(0, budget.specValues + 1).join(", ")}`),
    );
  const parts = [
    `Category words (not qualifiers): ${mining.coreTerms.join(", ") || "(none detected)"}`,
  ];
  if (dimLines.length) parts.push(block("CATEGORY_DIMENSIONS", dimLines.join("\n")));
  else parts.push("No category dimensions were provided — use the fallback dimensions.");
  const ctx = excerpt(context, budget.labelContextChars, [
    ...dims.ranking,
    ...dims.listing.map((d) => d.name),
  ]);
  if (ctx) parts.push(block("CATEGORY_CONTEXT_EXCERPT", ctx));
  parts.push(block("TERMS", `term | example keyword\n${lines.join("\n")}`));
  return parts.join("\n");
}

// ───────────────────────────── 2 · listing field mapping ─────────────────────────────

export const FIELD_MAP_SYSTEM = composeSystemPrompt("fields");

export function buildFieldMapUser(
  summary: ReturnType<typeof specSummary>,
  listingCount: number,
  budget: PromptBudget = BUDGETS.normal,
) {
  const lines = summary
    .slice(0, budget.fieldSpecs)
    .map((f) => `${f.spec} | ${f.fillPct}% | ${f.samples.join(" / ")}`);
  return [
    `${listingCount} listings.`,
    block("SPECS", `spec name | filled | samples\n${lines.join("\n")}`),
  ].join("\n");
}

// ───────────────────────────── 3 · master filter-design prompt ─────────────────────────────

export const FILTER_DESIGN_SYSTEM = composeSystemPrompt("design");

/**
 * "Include UI design" unticked: skill 09 no longer contributes prompt text either way (options and
 * UI patterns are always code-derived, see skill 09), so this is the same system prompt as
 * FILTER_DESIGN_SYSTEM — kept as a separate export so callers don't need to know that, and so
 * excluding "options" here still works if a future skill 09 rewrite adds prompt text back.
 */
export const FILTER_DESIGN_SYSTEM_NO_UI = composeSystemPrompt("design", ["options"]);

export const NO_UI_NOTE =
  'UI DESIGN IS SWITCHED OFF for this run: decide only which filters exist, their tier, rank, confidence and rationale. Return "interaction_rules": [] and do not spend any output reasoning about options or UI patterns — those are not part of your output.';

// ───────────────────────────── design-stage user message ─────────────────────────────

export interface DesignEvidence {
  category: string | null;
  tables: KeywordTable[];
  mining: TermMining | null;
  aggregation: Aggregation | null;
  context: string;
  specs: string;
  listing: ListingProfile | null;
  demoListings?: boolean;
  uiDesign?: boolean;
  budget?: PromptBudget;
}

function metricName(t: KeywordTable | undefined) {
  return t?.demandMetric ?? "keyword count";
}

function formatSourceOverview(tables: KeywordTable[]) {
  return tables
    .map((t) => {
      const parts = [
        `${SOURCE_LABEL[t.source]}: ${fmt(t.rows.length)} unique keywords`,
        `demand metric "${metricName(t)}" total ${fmt(t.totalDemand)}`,
      ];
      if (t.actionMetric)
        parts.push(`action metric "${t.actionMetric}" total ${fmt(t.totalAction)}`);
      if (t.rateMetrics.length)
        parts.push(`rates: ${t.rateMetrics.join(", ")} (demand-weighted, %)`);
      return `- ${parts.join(" · ")}`;
    })
    .join("\n");
}

const SHORT: Record<string, string> = { internal: "INT", serp: "SERP" };
const MINOR_COVERAGE = 1; // % — dimensions below this in every source get one summary line

function formatDimensions(agg: Aggregation, tables: KeywordTable[], budget: PromptBudget) {
  const MAX_VALUES = budget.maxValues;
  const rateCols = (t: KeywordTable) => (budget.rates ? t.rateMetrics.slice(0, 2) : []);
  const sources = tables.map((t) => t.source);
  const tableOf = (s: string) => tables.find((t) => t.source === s)!;
  const out: string[] = [];
  out.push(
    `Column prefixes: ${sources.map((s) => `${SHORT[s]} = ${SOURCE_LABEL[s]}`).join(", ")}.`,
    `Generic share (no qualifier at all): ${sources
      .map((s) => `${SHORT[s]} ${pctStr(agg.genericShare[s] ?? 0)}`)
      .join(" · ")}`,
  );
  const major = agg.dimensions.filter((d) =>
    sources.some((s) => (d.bySource[s]?.coverage ?? 0) >= MINOR_COVERAGE),
  );
  const minor = agg.dimensions.filter((d) => !major.includes(d));

  for (const d of major) {
    const head = sources
      .filter((s) => d.bySource[s])
      .map((s) => {
        const x = d.bySource[s]!;
        const t = tableOf(s);
        return `${SHORT[s]}: coverage ${pctStr(x.coverage)}, top-value share ${pctStr(x.topShare)}, ${x.keywords} kws${
          t.actionMetric ? `, ${fmt(x.action)} ${t.actionMetric}` : ""
        }`;
      })
      .join(" · ");
    out.push("", `DIMENSION ${d.name} — ${head}`);
    const cols = sources.flatMap((s) => {
      const t = tableOf(s);
      const c = [`${SHORT[s]} ${metricName(t)}`, `${SHORT[s]} share`];
      if (t.actionMetric) c.push(`${SHORT[s]} ${t.actionMetric}`);
      for (const r of rateCols(t)) c.push(`${SHORT[s]} ${r}`);
      return c;
    });
    out.push(`value | ${cols.join(" | ")}`);
    for (const v of d.values.slice(0, MAX_VALUES)) {
      const cells = sources.flatMap((s) => {
        const t = tableOf(s);
        const b = v.bySource[s];
        const c = b ? [fmt(b.demand), pctStr(b.share)] : ["–", "–"];
        if (t.actionMetric) c.push(b ? fmt(b.action) : "–");
        for (const r of rateCols(t))
          c.push(b && b.rates[r] !== undefined ? pctStr(b.rates[r]!) : "–");
        return c;
      });
      out.push(`${v.value} | ${cells.join(" | ")}`);
    }
    if (d.values.length > MAX_VALUES) out.push(`(+${d.values.length - MAX_VALUES} smaller values)`);
  }
  if (minor.length) {
    out.push(
      "",
      `Minor dimensions (coverage < ${MINOR_COVERAGE}% everywhere): ${minor
        .map(
          (d) =>
            `${d.name} (${d.values
              .map((v) => v.value)
              .slice(0, 4)
              .join(", ")})`,
        )
        .join("; ")}`,
    );
  }
  return out.join("\n");
}

function formatRawTerms(mining: TermMining, tables: KeywordTable[], limit: number) {
  const sources = tables.map((t) => t.source);
  const lines = mining.terms.slice(0, limit).map(
    (t) =>
      `${t.term} | ${sources
        .map((s) => {
          const x = t.bySource[s];
          return `${SHORT[s]} ${x ? `${x.keywords} kws / ${fmt(x.demand)}` : "–"}`;
        })
        .join(" | ")}`,
  );
  return [
    "Terms could not be grouped into dimensions, so raw term totals are listed. Group them yourself; keywords contain several terms, so totals overlap — cite them individually, never add them up.",
    ...lines,
  ].join("\n");
}

function formatTopKeywords(tables: KeywordTable[], n = 10) {
  return tables
    .map((t) => {
      const rows = t.rows.slice(0, n).map((r) => {
        const extra = t.actionMetric ? ` / ${fmt(r.action)}` : "";
        return `${r.query} — ${fmt(r.demand)}${extra}`;
      });
      const unit = `${metricName(t)}${t.actionMetric ? ` / ${t.actionMetric}` : ""}`;
      return `Top ${rows.length} ${SOURCE_LABEL[t.source]} keywords (${unit}):\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

/** ₹ in Indian units (Lakh / Crore) — also used to build default price-range option labels. */
export function formatLakh(n: number) {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, "")} Crore`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2).replace(/\.?0+$/, "")} Lakh`;
  return `₹${fmt(n)}`;
}

function formatListing(p: ListingProfile, demo: boolean, budget: PromptBudget) {
  // Specs almost nobody fills are summarised by name only (a demo sample keeps more of them visible).
  const minFill = demo ? 1 : 5;
  const shown = p.fields.filter((f) => f.fillPct >= minFill).slice(0, budget.maxSpecs);
  const rare = p.fields.filter((f) => !shown.includes(f));
  const lines = [
    `${p.count} listings profiled.`,
    "spec | filled | distinct values | most common values (count)",
    ...shown.map(
      (f) =>
        `${f.key} | ${f.fillPct}% | ${f.distinct} | ${f.top
          .slice(0, budget.specValues)
          .map(([v, n]) => `${v.slice(0, budget.valueChars)} (${n})`)
          .join(", ")}`,
    ),
  ];
  if (rare.length)
    lines.push(
      `Rarely filled (below ${minFill}% or beyond the top ${shown.length}): ${rare
        .slice(0, 40)
        .map((f) => `${f.key} ${f.fillPct}%`)
        .join(", ")}${rare.length > 40 ? `, +${rare.length - 40} more` : ""}`,
    );
  if (p.price) {
    const u = p.price.unit ? ` per ${p.price.unit}` : "";
    lines.push(
      "",
      `PRICE (${p.price.n} listings priced${u}${p.price.otherUnits ? `; ${p.price.otherUnits} more quote other units and are excluded` : ""}): min ${formatLakh(p.price.min)} · 25th pct ${formatLakh(p.price.p25)} · median ${formatLakh(p.price.median)} · 75th pct ${formatLakh(p.price.p75)} · max ${formatLakh(p.price.max)}`,
    );
  } else {
    lines.push("", "PRICE: not enough priced listings to compute a distribution.");
  }
  return lines.join("\n");
}

export function buildDesignUser(ev: DesignEvidence) {
  const budget = ev.budget ?? BUDGETS.normal;
  const parts: string[] = [];
  parts.push(`CATEGORY: ${ev.category ?? "(infer it from the evidence)"}`);
  const present = [
    ev.tables.length ? "A" : null,
    ev.context.trim() ? "B" : null,
    ev.specs.trim() ? "C" : null,
    ev.listing ? "D" : null,
  ].filter(Boolean);
  parts.push(`Evidence present: ${present.join(", ") || "none"}.`);

  if (ev.tables.length) {
    const body = [
      "Sources:",
      formatSourceOverview(ev.tables),
      ev.mining
        ? `Category core words (not qualifiers): ${ev.mining.coreTerms.join(", ") || "(none detected)"}`
        : "",
      "",
      ev.aggregation && ev.aggregation.dimensions.length
        ? formatDimensions(ev.aggregation, ev.tables, budget)
        : ev.mining
          ? formatRawTerms(ev.mining, ev.tables, budget.rawTerms)
          : "",
      "",
      formatTopKeywords(ev.tables, budget.topKeywords),
    ].join("\n");
    parts.push(
      "",
      "## A. KEYWORD DEMAND (computed by code — numbers are exact)",
      block("KEYWORD_EVIDENCE", body),
    );
  }
  if (ev.context.trim()) {
    // Only the parts of a long context doc that talk about this category's specs and buyer choice.
    const keywords = [
      ...(ev.aggregation?.dimensions.flatMap((d) => [
        d.name,
        ...d.values.slice(0, 3).map((v) => v.value),
      ]) ?? []),
      ...(ev.listing?.fields.slice(0, 20).map((f) => f.key.replace(/^isq\./, "")) ?? []),
      ...ev.specs.split(/[\n,;|:]/).map((x) => x.replace(/^\s*[-•*]?\s*\d+\s*[-.)]\s*/, "")),
    ];
    parts.push(
      "",
      "## B. CATEGORY CONTEXT",
      block("CONTEXT", excerpt(ev.context, budget.contextChars, keywords)),
    );
  }
  if (ev.specs.trim())
    parts.push(
      "",
      "## C. SPEC IMPORTANCE RANKING (category manager)",
      block("RANKING", clip(ev.specs, budget.rankingChars)),
    );
  if (ev.listing)
    parts.push(
      "",
      "## D. LISTING SPEC PROFILE (computed by code)",
      block("LISTINGS", formatListing(ev.listing, Boolean(ev.demoListings), budget)),
    );

  if (ev.listing && ev.demoListings)
    parts.push(
      "",
      'NOTE: the listing data (D) is a DEMO SAMPLE, not the full catalogue. Low fill rates are expected: do NOT drop or demote a filter because of low fill. Keep it in the tier its demand and context earn, and add the fill note to its rationale (e.g. "(only 12% of sample listings fill this — needs ISQ push)").',
    );
  if (ev.uiDesign === false) parts.push("", NO_UI_NOTE);
  parts.push("", "Design the filter panel now. Reply with the JSON object only.");
  return parts.join("\n");
}
