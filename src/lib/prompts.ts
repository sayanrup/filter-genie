import {
  SOURCE_LABEL,
  type Aggregation,
  type KeywordSource,
  type KeywordTable,
  type ListingProfile,
  type TermMining,
  type rawFieldSummary,
} from "./data";
import { REPAIR_INSTRUCTION, composeSystemPrompt } from "@/skills";

/*
 * System prompts are assembled from the skill docs in src/skills (base.md + one .md per layer).
 * This file only builds the per-run USER messages — the data blocks the model reads:
 *   1. term labelling    — mined keyword terms to label with a dimension + clean value
 *   2. field mapping     — listing export fields to map onto canonical spec names
 *   3. filter design     — the computed evidence (dimension tables, context, ranking, listing profile)
 * All numbers the model sees in step 3 are computed by code, so it never has to add anything up.
 */

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const pctStr = (n: number) => `${n}%`;

/** Wrap untrusted user data so the model treats it as data, not instructions. */
function block(label: string, body: string) {
  return `<<<${label}\n${body.trim()}\n${label}>>>`;
}

function clip(text: string, max: number) {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.lastIndexOf("\n", max);
  return `${t.slice(0, cut > max * 0.7 ? cut : max)}\n[… truncated — ${fmt(t.length - max)} more characters not shown]`;
}

// ───────────────────────────── 1 · term labelling ─────────────────────────────

export const TERM_LABEL_SYSTEM = composeSystemPrompt("label");

function termSourceCell(t: TermMining["terms"][number], src: KeywordSource) {
  const s = t.bySource[src];
  return s ? `${s.keywords}/${fmt(s.demand)}` : "–";
}

export function buildTermLabelUser(tables: KeywordTable[], mining: TermMining) {
  const sources = tables.map((t) => t.source);
  const header = [
    "term",
    ...sources.map(
      (s) =>
        `${SOURCE_LABEL[s]} kws/${tables.find((t) => t.source === s)?.demandMetric ?? "count"}`,
    ),
    "hint",
    "example keyword",
  ].join(" | ");
  const lines = mining.terms.map((t) =>
    [
      t.term,
      ...sources.map((s) => termSourceCell(t, s)),
      t.hint ? `[${t.hint}]` : "",
      t.example,
    ].join(" | "),
  );
  return [
    `Category core words (already excluded from the terms): ${mining.coreTerms.join(", ") || "(none detected)"}`,
    `Keywords analysed: ${fmt(mining.totalKeywords)} across ${tables.map((t) => SOURCE_LABEL[t.source]).join(" + ")}.`,
    "",
    block("TERMS", [header, ...lines].join("\n")),
    "",
    "Label the terms now. Reply with the JSON object only.",
  ].join("\n");
}

// ───────────────────────────── 2 · listing field mapping ─────────────────────────────

export const FIELD_MAP_SYSTEM = composeSystemPrompt("fields");

export function buildFieldMapUser(
  summary: ReturnType<typeof rawFieldSummary>,
  listingCount: number,
) {
  const lines = summary.map(
    (f) => `${f.key} | ${f.fillPct}% | ${f.samples.map((s) => JSON.stringify(s)).join(", ")}`,
  );
  return [
    `${listingCount} listings. Fields (source field | filled | sample values):`,
    block("FIELDS", lines.join("\n")),
    "",
    "Map every field. Reply with the JSON object only.",
  ].join("\n");
}

// ───────────────────────────── 3 · master filter-design prompt ─────────────────────────────

export const FILTER_DESIGN_SYSTEM = composeSystemPrompt("design");

// ───────────────────────────── design-stage user message ─────────────────────────────

export interface DesignEvidence {
  category: string | null;
  tables: KeywordTable[];
  mining: TermMining | null;
  aggregation: Aggregation | null;
  context: string;
  specs: string;
  listing: ListingProfile | null;
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

function formatDimensions(agg: Aggregation, tables: KeywordTable[]) {
  const sources = tables.map((t) => t.source);
  const out: string[] = [];
  out.push(
    `Generic share (no qualifier at all): ${sources
      .map((s) => `${SOURCE_LABEL[s]} ${pctStr(agg.genericShare[s] ?? 0)}`)
      .join(" · ")}`,
  );
  for (const d of agg.dimensions) {
    const head = sources
      .filter((s) => d.bySource[s])
      .map((s) => {
        const x = d.bySource[s]!;
        return `${SOURCE_LABEL[s]}: coverage ${pctStr(x.coverage)}, top-value share ${pctStr(x.topShare)}, ${x.keywords} kws${
          tables.find((t) => t.source === s)?.actionMetric
            ? `, ${fmt(x.action)} ${tables.find((t) => t.source === s)!.actionMetric}`
            : ""
        }`;
      })
      .join(" · ");
    out.push("", `DIMENSION ${d.name} — ${head}`);
    const cols = sources.flatMap((s) => {
      const t = tables.find((x) => x.source === s)!;
      const c = [`${SOURCE_LABEL[s]} kws`, `${metricName(t)}`, "share"];
      if (t.actionMetric) c.push(t.actionMetric);
      for (const r of t.rateMetrics) c.push(r);
      return c;
    });
    out.push(`value | ${cols.join(" | ")}`);
    for (const v of d.values.slice(0, 20)) {
      const cells = sources.flatMap((s) => {
        const t = tables.find((x) => x.source === s)!;
        const b = v.bySource[s];
        const c = b ? [String(b.keywords), fmt(b.demand), pctStr(b.share)] : ["–", "–", "–"];
        if (t.actionMetric) c.push(b ? fmt(b.action) : "–");
        for (const r of t.rateMetrics)
          c.push(b && b.rates[r] !== undefined ? pctStr(b.rates[r]!) : "–");
        return c;
      });
      out.push(`${v.value} | ${cells.join(" | ")}`);
    }
    if (d.values.length > 20) out.push(`(+${d.values.length - 20} smaller values not shown)`);
  }
  return out.join("\n");
}

function formatRawTerms(mining: TermMining, tables: KeywordTable[]) {
  const sources = tables.map((t) => t.source);
  const lines = mining.terms.slice(0, 120).map(
    (t) =>
      `${t.term}${t.hint ? ` [${t.hint}]` : ""} | ${sources
        .map((s) => {
          const x = t.bySource[s];
          return x
            ? `${SOURCE_LABEL[s]} ${x.keywords} kws / ${fmt(x.demand)}`
            : `${SOURCE_LABEL[s]} –`;
        })
        .join(" | ")}`,
  );
  return [
    "Terms could not be pre-grouped into dimensions, so raw term totals are listed. Group them into dimensions yourself; keywords can contain several terms, so term totals overlap — don't add them up, cite them individually.",
    ...lines,
  ].join("\n");
}

function formatTopKeywords(tables: KeywordTable[], n = 25) {
  return tables
    .map((t) => {
      const rows = t.rows.slice(0, n).map((r) => {
        const extra = t.actionMetric ? ` · ${fmt(r.action)} ${t.actionMetric}` : "";
        return `${r.query} — ${fmt(r.demand)} ${metricName(t)}${extra}`;
      });
      return `${SOURCE_LABEL[t.source]} (top ${rows.length} by ${metricName(t)}):\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

function formatLakh(n: number) {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, "")} Crore`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2).replace(/\.?0+$/, "")} Lakh`;
  return `₹${fmt(n)}`;
}

function formatListing(p: ListingProfile) {
  const lines = [
    `${p.count} listings profiled${p.mapped ? " (source fields merged onto canonical specs)" : " (raw field names)"}.`,
    "spec | filled | distinct values | most common values (count)",
    ...p.fields.map(
      (f) =>
        `${f.key} | ${f.fillPct}% (${f.filled}/${p.count}) | ${f.distinct} | ${f.top.map(([v, n]) => `${v} (${n})`).join(", ")}`,
    ),
  ];
  if (p.price) {
    const u = p.price.unit ? ` per ${p.price.unit}` : "";
    lines.push(
      "",
      `PRICE (${p.price.n} listings with a price${u}): min ${formatLakh(p.price.min)} · 25th pct ${formatLakh(p.price.p25)} · median ${formatLakh(p.price.median)} · 75th pct ${formatLakh(p.price.p75)} · max ${formatLakh(p.price.max)}`,
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
    parts.push("", "## B. CATEGORY CONTEXT", block("CONTEXT", clip(ev.context, 10000)));
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
      block("LISTINGS", formatListing(ev.listing)),
    );

  parts.push("", "Design the filter panel now. Reply with the JSON object only.");
  return parts.join("\n");
}

// ───────────────────────────── repair turn ─────────────────────────────

export function buildRepairUser(issues: string[]) {
  return [
    "Your answer has these problems:",
    ...issues.map((i) => `- ${i}`),
    "",
    REPAIR_INSTRUCTION,
  ].join("\n");
}
