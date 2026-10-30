import {
  NO_UNIT,
  SELLER_CITY,
  SOURCE_LABEL,
  THIN_LISTINGS,
  type Aggregation,
  type KeywordTable,
  type ListingProfile,
  type TermMining,
  type TermStat,
  type DimensionCandidates,
  type UnitGroup,
  type specSummary,
} from "./data";
import { composeSystemPrompt, MCAT_SKILLS } from "@/skills";
import { describeKeywordSelection, nameTokens, type McatScope } from "./mcats";
import type { FilterRow } from "./filter-gen";
import type { DocMcat } from "./category-doc";

/*
 * System prompts are assembled from the skill docs in src/skills (base.md + one .md per layer).
 * This file only builds the per-run USER messages — the data blocks the model reads:
 *   1. term labelling    — mined keyword terms, and the numbers typed in them grouped by unit word
 *   2. field mapping     — canonical spec names to merge or drop
 *   3. filter design     — the computed evidence (dimension tables, context, ranking, listing profile)
 *   4. numeric ranges    — the final filters with their ISQ values (lower / upper bounds, skill 14)
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
/** Sibling MCATs listed in a labelling prompt at most (the ones its terms name; see buildTermLabelUser). */
const MAX_SIBLINGS = 40;
/** Multi-MCAT runs: the keywords are common to all MCATs, so the labeller is told whose qualifiers to label. */
export const TERM_LABEL_SYSTEM_MCAT = composeSystemPrompt("label", [], MCAT_SKILLS.label);

/** `short`'s letters appear in `long` in order: "dx" in "directexpansion". */
const inOrder = (short: string, long: string) => {
  let i = 0;
  for (const c of long) if (c === short[i]) i++;
  return i === short.length;
};

/** A short form and the full form a value writes it with: "Direct Expansion (DX)", "MS (Mild Steel)". */
function shortForm(value: string): string | null {
  const a = value.match(/^(.+?)\s*\(\s*([A-Za-z]{2,6})\s*\)$/);
  const b = value.match(/^([A-Z]{2,6})\s*\(\s*(.+?)\s*\)$/);
  const [short, full] = a ? [a[2]!, a[1]!] : b ? [b[1]!, b[2]!] : ["", ""];
  if (!short || short !== short.toUpperCase()) return null;
  const letters = full.toLowerCase().replace(/[^a-z]/g, "");
  const s = short.toLowerCase();
  return letters[0] === s[0] && inOrder(s, letters) ? s : null;
}

/**
 * Worked examples for the labelling prompt, taken from this MCAT's own data so they fit its category (no fixed
 * examples from another one): a term that is one of its listing values, a short form its listings write out, a
 * unit word its listings use, and a term that names a sibling MCAT. Each is true of the data by construction.
 */
function labelExamples(
  terms: TermStat[],
  dims: DimensionCandidates,
  units: UnitGroup[],
  mcat: McatScope | null,
  siblings: string[],
): string[] {
  const sent = new Set(terms.map((t) => t.term));
  const specs = dims.listing.filter((d) => !/\b(city|location)\b/i.test(d.name));
  const out: string[] = [];

  const valueOf: string[] = [];
  for (const d of specs) {
    if (valueOf.length >= 2) break;
    // An option written all in lower case is usually a seller's free text in the wrong field ("puf" as a Brand).
    const v = d.values.find(
      (x) =>
        /^[A-Za-z][A-Za-z-]{2,14}$/.test(x) && x !== x.toLowerCase() && sent.has(x.toLowerCase()),
    );
    if (v) valueOf.push(`"${v.toLowerCase()}" → ${d.name} = ${v}`);
  }
  if (valueOf.length)
    out.push("A term that is a listing value → that spec:", ...valueOf.map((l) => `  ${l}`));

  const forms = specs.flatMap((d) =>
    d.values.flatMap((v) => {
      const s = shortForm(v);
      return s ? [{ s, line: `"${s}" → ${d.name} = ${v}`, typed: sent.has(s) }] : [];
    }),
  );
  const shown = forms.sort((a, b) => Number(b.typed) - Number(a.typed)).slice(0, 2);
  if (shown.length)
    out.push(
      "A short form this category's listings write out → the value as written:",
      ...shown.map((f) => `  ${f.line}`),
    );

  for (const u of units) {
    if (!u.unit) continue;
    const at = new RegExp(
      `^\\d+(?:\\.\\d+)?\\s*${u.unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    );
    const d = specs.find((x) => x.values.some((v) => at.test(v.trim())));
    if (!d) continue;
    const written = d.values.find((v) => at.test(v.trim()))!.replace(/^[\d.\s]+/, "");
    out.push(
      "A unit word → the dimension its numbers measure, unit as the listings write it:",
      `  "${u.unit}" (${u.amounts.slice(0, 3).join(", ")}) → ${d.name}, unit "${written}"`,
    );
    break;
  }

  if (mcat) {
    // Only where the term's example keyword holds the sibling's whole name ("ms porta cabin price"): a word that
    // merely shares a sibling's name ("machine", "milk") is often a real qualifier of this MCAT.
    const own = new Set(nameTokens(mcat.name));
    for (const t of terms) {
      const words = nameTokens(t.term);
      const said = new Set(nameTokens(t.example));
      const sib = words.length
        ? siblings.find((s) => {
            const sw = nameTokens(s);
            return (
              sw.every((w) => said.has(w)) && words.every((w) => sw.includes(w) && !own.has(w))
            );
          })
        : undefined;
      if (!sib) continue;
      out.push(
        "A term that names a sibling MCAT, not a qualifier of this one → skip:",
        `  "${t.term}" names ${sib}`,
      );
      break;
    }
  }
  return out;
}

export function buildTermLabelUser(
  terms: TermStat[],
  mining: TermMining,
  dims: DimensionCandidates,
  context: string,
  budget: PromptBudget = BUDGETS.normal,
  mcat: McatScope | null = null,
  units: UnitGroup[] = [],
) {
  // No demand numbers: labelling doesn't need them. Skip the example when it's just the term itself.
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
  const parts: string[] = [];
  let siblings: string[] = [];
  if (mcat) {
    // Only the siblings a term could name ("office" for Office Cabin), those of the highest-demand terms first and
    // at most MAX_SIBLINGS: the rest can't matter to this list, and a subcategory of hundreds of MCATs would
    // otherwise cost hundreds of tokens per call.
    const siblingWords = mcat.siblings.map((s) => [s, nameTokens(s)] as const);
    const named: string[] = [];
    for (const t of [
      ...terms.slice(0, budget.labelTerms).map((x) => x.term),
      ...units.map((u) => u.unit),
    ]) {
      const words = nameTokens(t);
      for (const [s, sw] of siblingWords)
        if (!named.includes(s) && sw.some((w) => words.includes(w))) named.push(s);
      if (named.length >= MAX_SIBLINGS) break;
    }
    siblings = named.slice(0, MAX_SIBLINGS);
    parts.push(
      block(
        "MCAT",
        [
          `MCAT: ${mcat.name}`,
          siblings.length
            ? `Sibling MCATs a term may name (each labelled in its own call): ${siblings.join(", ")}`
            : `Sibling MCATs: none of the ${mcat.siblings.length} others shares a word with these terms.`,
        ].join("\n"),
      ),
    );
  }
  parts.push(
    `Category words (not qualifiers): ${mining.coreTerms.join(", ") || "(none detected)"}`,
  );
  if (dimLines.length) parts.push(block("CATEGORY_DIMENSIONS", dimLines.join("\n")));
  else parts.push("No category dimensions were provided — use the fallback dimensions.");
  const ctx = excerpt(context, budget.labelContextChars, [
    ...dims.ranking,
    ...dims.listing.map((d) => d.name),
  ]);
  if (ctx) parts.push(block("CATEGORY_CONTEXT_EXCERPT", ctx));
  const examples = labelExamples(terms.slice(0, budget.labelTerms), dims, units, mcat, siblings);
  if (examples.length) parts.push(block("EXAMPLES", examples.join("\n")));
  if (lines.length) parts.push(block("TERMS", `term | example keyword\n${lines.join("\n")}`));
  // Numbers typed with a word after them, one line per word: the model says once what that word's numbers measure.
  if (units.length)
    parts.push(
      block(
        "UNIT_TERMS",
        `unit | numbers seen | example keyword\n${units
          .map((u) => `${u.unit || NO_UNIT} | ${u.amounts.slice(0, 8).join(", ")} | ${u.example}`)
          .join("\n")}`,
      ),
    );
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
    .filter((f) => f.spec !== SELLER_CITY)
    .slice(0, budget.fieldSpecs)
    .map((f) => `${f.spec} | ${f.fillPct}% | ${f.top.map(([v, n]) => `${v} (${n})`).join(" / ")}`);
  return [
    `${listingCount} listings.`,
    block("SPECS", `spec name | filled | most common values (listings)\n${lines.join("\n")}`),
  ].join("\n");
}

// ───────────────────────────── 4 · numeric ranges ─────────────────────────────

export const RANGES_SYSTEM = composeSystemPrompt("ranges");

/**
 * The final filters with all their ISQ values, for the ranges step (skill 14). Only filters with a digit in
 * some value are sent: a filter without one can't hold a quantity. The listing stats say what kind of
 * quantity it is and in what unit; the bounds themselves come from the value text.
 */
export function buildRangesUser(filters: FilterRow[], listing: ListingProfile | null) {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sendable = filters.filter((f) => f.values.some((v) => /\d/.test(v)));
  const lines = sendable.map((f, i) => {
    const spec = f.linked_listing_spec
      ? listing?.fields.find((x) => key(x.key) === key(f.linked_listing_spec!))
      : undefined;
    const out = [`${i + 1}. ${f.name} · ${f.tier}`, `   values: ${f.values.join(" | ")}`];
    if (spec)
      out.push(
        `   listings: spec "${spec.key}" filled ${spec.fillPct}% (${spec.filled} of ${listing?.count ?? "?"} listings) · ${spec.distinct} distinct values · values with listing counts: ${(
          spec.all ?? spec.top
        )
          .slice(0, 30)
          .map(([v, n]) => `${v.slice(0, 30)} (${n})`)
          .join(", ")}`,
      );
    if (/price|budget|cost/i.test(f.name) && listing?.price) {
      const p = listing.price;
      out.push(
        `   priced listings: ${p.n}${p.unit ? ` per ${p.unit}` : ""} · min ₹${fmt(p.min)} · 25th pct ₹${fmt(p.p25)} · median ₹${fmt(p.median)} · 75th pct ₹${fmt(p.p75)} · max ₹${fmt(p.max)}`,
      );
    }
    return out.join("\n");
  });
  return [
    `${sendable.length} filter(s) with numbers in their values.`,
    block("FILTERS", lines.join("\n")),
  ].join("\n");
}

// ───────────────────────────── 5 · category document pairing ─────────────────────────────

export const DOC_MATCH_SYSTEM = composeSystemPrompt("select");

/**
 * The ISQs that need the category document (measurements and thin ones, skill 15) with their values, and the
 * document's ISQs for this MCAT. No numbers: pairing names doesn't need them, and code scores every value.
 */
export function buildDocMatchUser(mcatName: string, filters: FilterRow[], doc: DocMcat) {
  const lines = filters.map(
    (f, i) =>
      `${i + 1}. ${f.name}: ${f.values.filter((v) => !/^other\b/i.test(v.trim())).join(" | ") || "(no values)"}`,
  );
  return [
    `MCAT: ${mcatName}`,
    block("ISQS", lines.join("\n")),
    block("DOCUMENT_ISQS", doc.isqs.map((q) => `${q.name}: ${q.values.join(" | ")}`).join("\n")),
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

/** Added to the labelling message when the first answer labelled nothing at all. */
export const LABEL_RETRY_NOTE =
  "NOTE: a first answer to this list labelled NOTHING. A list like this nearly always holds filterable qualifiers (type, material, capacity, feature, application, brand, condition). Go through the TERMS again and label every term that is one, following the rules; skip only the ones that really are not.";

/** The same two prompts with skill 12 (MCAT scope) added, for runs that cover one MCAT of a subcategory. */
export const FILTER_DESIGN_SYSTEM_MCAT = composeSystemPrompt("design", [], MCAT_SKILLS.design);
export const FILTER_DESIGN_SYSTEM_NO_UI_MCAT = composeSystemPrompt(
  "design",
  ["options"],
  MCAT_SKILLS.design,
);

export function designSystemFor(uiDesign: boolean, mcat: boolean): string {
  if (mcat) return uiDesign ? FILTER_DESIGN_SYSTEM_MCAT : FILTER_DESIGN_SYSTEM_NO_UI_MCAT;
  return uiDesign ? FILTER_DESIGN_SYSTEM : FILTER_DESIGN_SYSTEM_NO_UI;
}

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
  /** Set when this run covers one MCAT of several; its keywords were picked from the common files. */
  mcat?: McatScope | null;
  /** C is the MCAT's live ISQs in seller-form order, not a category manager's ranking. */
  rankingFrom?: "live-isqs";
}

/** The MCAT_SCOPE block: which MCAT this is, what the keyword numbers really describe, how thin the evidence is. */
function formatMcatScope(m: McatScope, hasKeywords: boolean) {
  const lines = [
    `MCAT: ${m.name}`,
    ...(m.subcat?.name ? [`Subcategory: ${m.subcat.name}`] : []),
    ...(m.pmcat ? [`Primary PMCAT (its parent product category): ${m.pmcat.name}`] : []),
    `Sibling MCATs (the other MCATs in this run, each designed in its own call): ${m.siblings.join(", ")}`,
    `This MCAT's own listings: ${fmt(m.listings)}`,
  ];
  const sel = m.keywordSelection ?? [];
  if (sel.length) {
    lines.push(
      "Keyword files: common to all MCATs. Code picked the keywords that are about THIS MCAT (its name, its PMCAT, or words only its own listings use) before this call, so every keyword number in A is a share of those keywords, not of the whole file.",
      `Keywords picked: ${describeKeywordSelection(sel)}`,
    );
  } else if (hasKeywords) {
    lines.push("Keywords: none were about this MCAT, so there is no keyword evidence (A).");
  }
  if (m.notes.length)
    lines.push("Thin or missing evidence for this MCAT:", ...m.notes.map((n) => `- ${n}`));
  return lines.join("\n");
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
  parts.push(`CATEGORY: ${ev.mcat?.name ?? ev.category ?? "(infer it from the evidence)"}`);
  const present = [
    ev.tables.length ? "A" : null,
    ev.context.trim() ? "B" : null,
    ev.specs.trim() ? "C" : null,
    ev.listing ? "D" : null,
  ].filter(Boolean);
  parts.push(`Evidence present: ${present.join(", ") || "none"}.`);
  if (ev.mcat)
    parts.push(
      "",
      "## MCAT SCOPE",
      block("MCAT_SCOPE", formatMcatScope(ev.mcat, ev.tables.length > 0)),
    );

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
      ev.rankingFrom === "live-isqs"
        ? "## C. LIVE ISQ ORDER (this MCAT's ISQs as today's seller form lists them, first = top)"
        : "## C. SPEC IMPORTANCE RANKING (category manager)",
      block(
        "RANKING",
        clip(
          // Each line says what it is, so a rationale quotes it as the live ISQ order it is.
          ev.rankingFrom === "live-isqs"
            ? ev.specs.replace(/^(\d+)-/gm, "live ISQ #$1: ")
            : ev.specs,
          budget.rankingChars,
        ),
      ),
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
  if (ev.listing && ev.listing.count < THIN_LISTINGS)
    parts.push(
      "",
      `NOTE: D holds only ${ev.listing.count} listing(s), so its fill rates and common values are rough. Do NOT drop or demote a filter for low fill on so few listings, and say in its rationale that the listing evidence is thin.`,
    );
  if (ev.uiDesign === false) parts.push("", NO_UI_NOTE);
  parts.push("", "Design the filter panel now. Reply with the JSON object only.");
  return parts.join("\n");
}
