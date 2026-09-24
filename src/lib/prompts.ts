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

// ───────────────────────────── 1 · term labelling ─────────────────────────────

export const TERM_LABEL_SYSTEM = composeSystemPrompt("label");

export function buildTermLabelUser(
  terms: TermStat[],
  mining: TermMining,
  dims: DimensionCandidates,
  context: string,
) {
  // No numbers: labelling doesn't need them. Skip the example when it's just the term itself.
  const lines = terms.map((t) =>
    t.example.toLowerCase().trim() === t.term ? t.term : `${t.term} | ${t.example}`,
  );
  const dimLines: string[] = [];
  if (dims.ranking.length)
    dimLines.push(`CM ranking (most important first): ${dims.ranking.join(", ")}`);
  if (dims.listing.length)
    dimLines.push(
      "Listing specs (name — common values):",
      ...dims.listing.map((d) => `${d.name} — ${d.values.join(", ")}`),
    );
  const parts = [
    `Category words (not qualifiers): ${mining.coreTerms.join(", ") || "(none detected)"}`,
  ];
  if (dimLines.length) parts.push(block("CATEGORY_DIMENSIONS", dimLines.join("\n")));
  else parts.push("No category dimensions were provided — use the fallback dimensions.");
  if (context.trim()) parts.push(block("CATEGORY_CONTEXT_EXCERPT", clip(context, 1500)));
  parts.push(block("TERMS", `term | example keyword\n${lines.join("\n")}`));
  return parts.join("\n");
}

// ───────────────────────────── 2 · listing field mapping ─────────────────────────────

export const FIELD_MAP_SYSTEM = composeSystemPrompt("fields");

export function buildFieldMapUser(summary: ReturnType<typeof specSummary>, listingCount: number) {
  const lines = summary.map((f) => `${f.spec} | ${f.fillPct}% | ${f.samples.join(" / ")}`);
  return [
    `${listingCount} listings.`,
    block("SPECS", `spec name | filled | samples\n${lines.join("\n")}`),
  ].join("\n");
}

// ───────────────────────────── 3 · master filter-design prompt ─────────────────────────────

export const FILTER_DESIGN_SYSTEM = composeSystemPrompt("design");

/** "Include UI design" unticked: the options & UI-pattern skill is left out of the master prompt. */
export const FILTER_DESIGN_SYSTEM_NO_UI = composeSystemPrompt("design", ["options"]);

export const NO_UI_NOTE =
  'UI DESIGN IS SWITCHED OFF for this run: decide only which filters exist, their tier, rank, confidence and rationale. Return "ui_pattern": "", "values": [] for every filter and "interaction_rules": []. Do not spend any output on options.';

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
const MAX_VALUES = 12;
const MINOR_COVERAGE = 1; // % — dimensions below this in every source get one summary line

function formatDimensions(agg: Aggregation, tables: KeywordTable[]) {
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
      for (const r of t.rateMetrics) c.push(`${SHORT[s]} ${r}`);
      return c;
    });
    out.push(`value | ${cols.join(" | ")}`);
    for (const v of d.values.slice(0, MAX_VALUES)) {
      const cells = sources.flatMap((s) => {
        const t = tableOf(s);
        const b = v.bySource[s];
        const c = b ? [fmt(b.demand), pctStr(b.share)] : ["–", "–"];
        if (t.actionMetric) c.push(b ? fmt(b.action) : "–");
        for (const r of t.rateMetrics)
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

function formatRawTerms(mining: TermMining, tables: KeywordTable[]) {
  const sources = tables.map((t) => t.source);
  const lines = mining.terms.slice(0, 80).map(
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

function formatLakh(n: number) {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, "")} Crore`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2).replace(/\.?0+$/, "")} Lakh`;
  return `₹${fmt(n)}`;
}

const MAX_SPECS = 30;

function formatListing(p: ListingProfile, demo = false) {
  // Specs almost nobody fills are summarised by name only (a demo sample keeps more of them visible).
  const minFill = demo ? 1 : 5;
  const shown = p.fields.filter((f) => f.fillPct >= minFill).slice(0, demo ? 40 : MAX_SPECS);
  const rare = p.fields.filter((f) => !shown.includes(f));
  const lines = [
    `${p.count} listings profiled.`,
    "spec | filled | distinct values | most common values (count)",
    ...shown.map(
      (f) =>
        `${f.key} | ${f.fillPct}% | ${f.distinct} | ${f.top
          .slice(0, 5)
          .map(([v, n]) => `${v.slice(0, 30)} (${n})`)
          .join(", ")}`,
    ),
  ];
  if (rare.length)
    lines.push(
      `Rarely filled (below ${minFill}% or beyond the top ${shown.length}): ${rare.map((f) => f.key).join(", ")}`,
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
        ? formatDimensions(ev.aggregation, ev.tables)
        : ev.mining
          ? formatRawTerms(ev.mining, ev.tables)
          : "",
      "",
      formatTopKeywords(ev.tables),
    ].join("\n");
    parts.push(
      "",
      "## A. KEYWORD DEMAND (computed by code — numbers are exact)",
      block("KEYWORD_EVIDENCE", body),
    );
  }
  if (ev.context.trim())
    parts.push("", "## B. CATEGORY CONTEXT", block("CONTEXT", clip(ev.context, 8000)));
  if (ev.specs.trim())
    parts.push(
      "",
      "## C. SPEC IMPORTANCE RANKING (category manager)",
      block("RANKING", clip(ev.specs, 3000)),
    );
  if (ev.listing)
    parts.push(
      "",
      "## D. LISTING SPEC PROFILE (computed by code)",
      block("LISTINGS", formatListing(ev.listing, ev.demoListings)),
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
