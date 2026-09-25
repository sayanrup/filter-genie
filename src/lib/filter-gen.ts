/* eslint-disable @typescript-eslint/no-explicit-any -- model replies are untyped JSON and are normalised field by field */
import {
  aggregate,
  alignAutoLabels,
  autoLabels,
  dimensionCandidates,
  flattenListing,
  heuristicFieldMap,
  mineTerms,
  profileListings,
  specSummary,
  termsForModel,
  toKeywordTable,
  type Aggregation,
  type DimensionStats,
  type KeywordTable,
  type ListingField,
  type ListingProfile,
  type PriceStats,
  type Row,
  type TermLabel,
  type TermMining,
  type TermStat,
  type DimensionCandidates,
} from "./data";
import {
  ContextLimitError,
  addUsage,
  chatJson,
  type ChatMessage,
  type LlmSettings,
  type Usage,
} from "./llm";
import {
  FIELD_MAP_SYSTEM,
  FILTER_DESIGN_SYSTEM,
  FILTER_DESIGN_SYSTEM_NO_UI,
  TERM_LABEL_SYSTEM,
  BUDGETS,
  buildDesignUser,
  formatLakh,
  type PromptBudget,
  buildFieldMapUser,
  buildTermLabelUser,
} from "./prompts";
import type { StageId } from "@/skills";

export * from "./llm";

export type Tier = "Tier 1" | "Tier 2" | "Tier 3";
export type Confidence = "High" | "Medium" | "Low";

export interface FilterRow {
  rank: number;
  tier: Tier;
  name: string;
  ui_pattern: string;
  values: string[];
  confidence: Confidence;
  rationale: string;
  sources?: string[];
  coverage_pct?: number | null;
  top_value_share_pct?: number | null;
  listing_fill_pct?: number | null;
  needs_new_isq?: boolean;
  isq_note?: string | null;
  /** The resolved evidence keys this filter is linked to (set by attachEvidence, never the model's
   *  raw string) — lets the UI show the exact dimension/spec rows this filter's numbers came from. */
  linked_dimension?: string | null;
  linked_listing_spec?: string | null;
}

export interface FilterResult {
  category_name?: string;
  total_keywords_analyzed?: number;
  filters: FilterRow[];
  interaction_rules?: string[];
  blockers?: string[];
}

export interface PipelineInputs {
  serpRows: Row[];
  internalRows: Row[];
  context: string;
  specs: string;
  listingRows: Row[];
  /** Listing data is a demo sample: keep low-fill filters and flag them instead of dropping them. */
  demoListings?: boolean;
  /** Ask for UI patterns, option values and interaction rules (default on). Off = filters + tiers only. */
  uiDesign?: boolean;
}

export type { StageId };

export type StepId = "prepare" | "label" | "fields" | "design" | "check";
export type StepStatus = "pending" | "running" | "done" | "skipped" | "error";

export interface StepStat {
  label: string;
  value: string | number;
}

export interface Step {
  id: StepId;
  label: string;
  /** What the step does, in one or two plain sentences. */
  description: string;
  status: StepStatus;
  detail?: string;
  /** Wall-clock time of the step. */
  ms?: number;
  /** Model calls made by this step (0 = code only). */
  calls?: number;
  usage?: Usage;
  /** The model answer came from this session's cache (no cost). */
  cached?: boolean;
  stats?: StepStat[];
  /** What went into the step: the prompt sent, or a summary of the data read. */
  input?: string;
  /** What came out: the model's answer, or a summary of what code produced. */
  output?: string;
}

export interface PromptRecord {
  id: string;
  title: string;
  /** Skill-doc stage whose composed system prompt this call uses. */
  stage?: StageId;
  messages: ChatMessage[];
}

export interface Evidence {
  category: string | null;
  tables: KeywordTable[];
  mining: TermMining | null;
  labels: TermLabel[];
  aggregation: Aggregation | null;
  listing: ListingProfile | null;
}

export interface PipelineRun {
  result: FilterResult;
  evidence: Evidence;
  warnings: string[];
  usage: Usage;
  calls: number;
  prompts: PromptRecord[];
}

export const INITIAL_STEPS: Step[] = [
  {
    id: "prepare",
    label: "Read & total the data",
    description:
      "Reads every input, finds the keyword and listing columns, mines search terms and labels price words, places and sizes itself. No model involved.",
    status: "pending",
  },
  {
    id: "label",
    label: "Label keyword terms",
    description:
      "Sends only the terms code couldn't label to the model, which maps each one to a dimension and value using the category's own spec names.",
    status: "pending",
  },
  {
    id: "fields",
    label: "Merge listing spec names",
    description:
      "Asks the model which listing spec names are synonyms or not specs at all, so fill rates are counted once per real spec. Skipped when code can map everything.",
    status: "pending",
  },
  {
    id: "design",
    label: "Design the filter panel",
    description:
      "The master prompt: demand tables, context, ranking and listing fill rates go in; ranked, tiered filters linked to their evidence come out.",
    status: "pending",
  },
  {
    id: "check",
    label: "Check & fix the output",
    description:
      "Code fills in coverage, share and fill rates from the evidence links, then enforces the tier rules and cleans options. No repair call.",
    status: "pending",
  },
];

/** Prompt messages as readable text for the "See the working" panel. */
export function messagesText(messages: ChatMessage[]): string {
  return messages.map((m) => `── ${m.role} ──\n${m.content}`).join("\n\n");
}

// ───────────────────────────── deterministic prep ─────────────────────────────

export interface Prepared {
  tables: KeywordTable[];
  mining: TermMining | null;
  /** Terms code couldn't label itself — the only ones sent to the model. */
  modelTerms: TermStat[];
  flatListings: Record<string, string>[];
  /** Code-only field roles / canonical spec names for every source field. */
  fieldMap: Map<string, string>;
  specs: ReturnType<typeof specSummary>;
  /** The category's own dimension names (ranking + listing specs) for keyword labelling. */
  dims: DimensionCandidates;
  context: string;
}

export function prepare(inputs: PipelineInputs): Prepared {
  const tables = [
    toKeywordTable(inputs.internalRows, "internal"),
    toKeywordTable(inputs.serpRows, "serp"),
  ].filter((t): t is KeywordTable => t !== null && t.rows.length > 0);
  const mining = tables.length ? mineTerms(tables) : null;
  const flatListings = inputs.listingRows.slice(0, 500).map((r) => flattenListing(r));
  const fieldMap = heuristicFieldMap(flatListings);
  return {
    tables,
    mining,
    modelTerms: mining ? termsForModel(mining) : [],
    flatListings,
    fieldMap,
    specs: specSummary(flatListings, fieldMap),
    dims: dimensionCandidates(
      inputs.specs,
      flatListings.length ? profileListings(flatListings, fieldMap) : null,
    ),
    context: inputs.context,
  };
}

/** The field-mapping call only helps when there are at least two specs that might be synonyms. */
const needsFieldCall = (prep: Prepared) => prep.specs.length >= 2;

function labelMessages(prep: Prepared, budget: PromptBudget = BUDGETS.normal): ChatMessage[] {
  return [
    { role: "system", content: TERM_LABEL_SYSTEM },
    {
      role: "user",
      content: buildTermLabelUser(prep.modelTerms, prep.mining!, prep.dims, prep.context, budget),
    },
  ];
}

function fieldMessages(prep: Prepared, budget: PromptBudget = BUDGETS.normal): ChatMessage[] {
  return [
    { role: "system", content: FIELD_MAP_SYSTEM },
    { role: "user", content: buildFieldMapUser(prep.specs, prep.flatListings.length, budget) },
  ];
}

/**
 * Run a model step with the normal prompt budget; if the provider says the prompt is too long,
 * rebuild it with the compact budget and try once more.
 */
async function withBudget<T>(
  run: (budget: PromptBudget) => Promise<T>,
  onCompact: () => void,
): Promise<T> {
  try {
    return await run(BUDGETS.normal);
  } catch (err) {
    if (!(err instanceof ContextLimitError)) throw err;
    onCompact();
    try {
      return await run(BUDGETS.compact);
    } catch (err2) {
      if (!(err2 instanceof ContextLimitError)) throw err2;
      throw new Error(
        `${err2.message} Even the compact prompt doesn't fit this model's context window. Pick a model with a larger context (e.g. Gemini 3.1 Flash Lite or DeepSeek V4.1 Flash), or shorten the context document.`,
      );
    }
  }
}

const STEP_NAME = {
  label: "keyword-labelling",
  fields: "spec-merging",
  design: "master (filter design)",
} as const;

const COMPACT_NOTE = (step: string) =>
  `The ${step} prompt was too long for this model, so it was re-sent in compact form (shorter context excerpt, fewer values and specs).`;

/** Prompts as they'd be sent, before any model call (for the "View prompts" panel). */
export function previewPrompts(inputs: PipelineInputs): PromptRecord[] {
  const prep = prepare(inputs);
  const out: PromptRecord[] = [];
  if (prep.modelTerms.length) {
    out.push({
      id: "label",
      stage: "label",
      title: "1 · Label keyword terms",
      messages: labelMessages(prep),
    });
  }
  if (needsFieldCall(prep)) {
    out.push({
      id: "fields",
      stage: "fields",
      title: "2 · Merge listing spec names",
      messages: fieldMessages(prep),
    });
  }
  const auto = prep.mining ? alignAutoLabels(autoLabels(prep.mining), prep.dims) : [];
  out.push({
    id: "design",
    stage: "design",
    title: "3 · Master prompt — design the filter panel",
    messages: [
      {
        role: "system",
        content: inputs.uiDesign === false ? FILTER_DESIGN_SYSTEM_NO_UI : FILTER_DESIGN_SYSTEM,
      },
      {
        role: "user",
        content: buildDesignUser({
          category: null,
          tables: prep.tables,
          mining: prep.mining,
          // Preview with the labels code already knows; step 1's labels are added at run time.
          aggregation: auto.length ? aggregate(prep.tables, auto) : null,
          context: inputs.context,
          specs: inputs.specs,
          listing: prep.flatListings.length
            ? profileListings(prep.flatListings, prep.fieldMap)
            : null,
          demoListings: Boolean(inputs.demoListings),
          uiDesign: inputs.uiDesign !== false,
        }).concat(
          prep.modelTerms.length
            ? "\n\n[Preview: at run time the dimension tables also include the dimensions labelled in step 1.]"
            : "",
        ),
      },
    ],
  });
  return out;
}

// ───────────────────────────── stage caches ─────────────────────────────

/*
 * Labelling and field mapping depend only on the keyword / listing data, not on the context doc or
 * ranking. Re-running Generate after editing those reuses the earlier answers instead of paying again.
 */
const stageCache = new Map<string, unknown>();

function cacheKey(settings: LlmSettings, messages: ChatMessage[]) {
  return `${settings.provider}|${settings.baseUrl}|${settings.model}\n${messages.map((m) => m.content).join("\n")}`;
}

function remember(key: string, value: unknown) {
  stageCache.set(key, value);
  if (stageCache.size > 24) stageCache.delete(stageCache.keys().next().value as string);
}

// ───────────────────────────── parsing model answers ─────────────────────────────

/** {"dimensions": {"Material": {"PUF": ["puf","puff"]}}} → labels (older [[term, dim, value]] also accepted). */
export function parseLabels(data: any, known: Set<string>): TermLabel[] {
  const out: TermLabel[] = [];
  const push = (term: unknown, dimension: unknown, value: unknown) => {
    if (typeof term !== "string" || typeof dimension !== "string" || typeof value !== "string")
      return;
    const t = term.toLowerCase().trim();
    if (known.has(t) && dimension.trim() && value.trim())
      out.push({ term: t, dimension: dimension.trim(), value: value.trim() });
  };
  const dims = data?.dimensions;
  if (dims && typeof dims === "object" && !Array.isArray(dims)) {
    for (const [dim, values] of Object.entries(dims as Record<string, unknown>)) {
      if (!values || typeof values !== "object") continue;
      for (const [value, terms] of Object.entries(values as Record<string, unknown>)) {
        for (const term of Array.isArray(terms) ? terms : [terms]) push(term, dim, value);
      }
    }
  }
  if (Array.isArray(data?.labels)) {
    for (const l of data.labels) {
      if (Array.isArray(l)) push(l[0], l[1], l[2]);
      else push(l?.term, l?.dimension, l?.value);
    }
  }
  return out;
}

/** Apply {"merge": {...}, "drop": [...]} from the model on top of the code-only field map. */
export function applySpecMerges(
  fieldMap: Map<string, string>,
  data: any,
): { map: Map<string, string>; changes: number } {
  const rename = new Map<string, string>();
  let changes = 0;
  const merge = data?.merge && typeof data.merge === "object" ? data.merge : {};
  for (const [target, sources] of Object.entries(merge as Record<string, unknown>)) {
    if (!target.trim()) continue;
    for (const src of Array.isArray(sources) ? sources : [])
      if (typeof src === "string") rename.set(src.toLowerCase(), target.trim());
  }
  for (const d of Array.isArray(data?.drop) ? data.drop : [])
    if (typeof d === "string") rename.set(d.toLowerCase(), "@ignore");

  const map = new Map<string, string>();
  for (const [key, role] of fieldMap) {
    const next = role.startsWith("@") ? role : (rename.get(role.toLowerCase()) ?? role);
    if (next !== role) changes++;
    map.set(key, next);
  }
  return { map, changes };
}

// ───────────────────────────── normalise, link evidence, fix ─────────────────────────────

const TIER_ALIASES: Record<string, Tier> = { "1": "Tier 1", "2": "Tier 2", "3": "Tier 3" };

interface RawLinks {
  dimension: string | null;
  listing_spec: string | null;
  backing: string[];
}

function normalizeResult(raw: any): { result: FilterResult; links: RawLinks[] } {
  const list: any[] = Array.isArray(raw?.filters) ? raw.filters : [];
  const links: RawLinks[] = [];
  const filters: FilterRow[] = list.map((f: any, i: number) => {
    const tierDigit = String(f?.tier ?? "").match(/[123]/)?.[0] ?? "2";
    const conf = String(f?.confidence ?? "").toLowerCase();
    links.push({
      dimension: typeof f?.dimension === "string" && f.dimension.trim() ? f.dimension.trim() : null,
      listing_spec:
        typeof f?.listing_spec === "string" && f.listing_spec.trim() ? f.listing_spec.trim() : null,
      backing: Array.isArray(f?.backing) ? f.backing.map(String) : [],
    });
    return {
      rank: Number(f?.rank) || i + 1,
      tier: TIER_ALIASES[tierDigit]!,
      name: String(f?.name ?? "").trim(),
      ui_pattern: String(f?.ui_pattern ?? "").trim(),
      values: Array.isArray(f?.values)
        ? f.values.map((v: unknown) => String(v).trim()).filter(Boolean)
        : [],
      confidence: conf.startsWith("h") ? "High" : conf.startsWith("l") ? "Low" : "Medium",
      rationale: String(f?.rationale ?? "").trim(),
      needs_new_isq: Boolean(f?.needs_new_isq),
      isq_note: f?.isq_note ? String(f.isq_note) : null,
    };
  });
  const result: FilterResult = {
    filters,
    interaction_rules: Array.isArray(raw?.interaction_rules)
      ? raw.interaction_rules.map(String)
      : [],
    blockers: Array.isArray(raw?.blockers) ? raw.blockers.map(String) : [],
  };
  if (raw?.category_name) result.category_name = String(raw.category_name);
  return { result, links };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const OTHER_FLOOR_PCT = 3; // values below this share of a dimension fold into "Other" (never for Location)
const MAX_DEFAULT_OPTIONS = 8;

/** "1000-5000" style listing-price buckets in Indian format, sized to the real distribution in D. */
function priceRanges(price: PriceStats): string[] {
  const { min, p25, median, p75, max } = price;
  const cuts = [...new Set([min, p25, median, p75, max])].sort((a, b) => a - b);
  if (cuts.length < 2) return [];
  const unit = price.unit ? `/${price.unit}` : "";
  const ranges: string[] = [`Under ${formatLakh(cuts[0]!)}${unit}`];
  for (let i = 0; i < cuts.length - 1; i++)
    ranges.push(`${formatLakh(cuts[i]!)} – ${formatLakh(cuts[i + 1]!)}${unit}`);
  ranges.push(`Above ${formatLakh(cuts[cuts.length - 1]!)}${unit}`);
  return ranges;
}

/**
 * "Values" and "ui_pattern" the model no longer has to write out: both follow deterministically
 * from evidence code already holds (the dimension's own values, the listing spec's common values,
 * tier, and whether the filter is Price/Location). The model may still send "values" itself to
 * override this — e.g. to merge near-duplicates or phrase a range — see attachEvidence().
 */
function deriveOptions(
  f: FilterRow,
  dim: DimensionStats | undefined,
  spec: ListingField | undefined,
  price: PriceStats | null,
  isPrice: boolean,
  isPlace: boolean,
): { values: string[]; ui_pattern: string } {
  if (f.tier === "Tier 3") {
    return { values: (spec?.top ?? []).slice(0, 4).map(([v]) => v), ui_pattern: "display only" };
  }
  if (isPrice) {
    return {
      values: price ? priceRanges(price) : [],
      ui_pattern: "range slider with presets",
    };
  }
  if (isPlace) {
    const fromSpec = (spec?.top ?? []).map(([v]) => v);
    const fromDim = (dim?.values ?? []).map((v) => v.value);
    return {
      values: [...new Set([...fromDim, ...fromSpec])].slice(0, 10),
      ui_pattern: "location search",
    };
  }

  let values: string[];
  if (dim && dim.values.length) {
    const total = dim.values.reduce(
      (s, v) => s + Math.max(...Object.values(v.bySource).map((b) => b?.demand ?? 0), 0),
      0,
    );
    const kept: string[] = [];
    let folded = false;
    for (const v of dim.values) {
      const demand = Math.max(...Object.values(v.bySource).map((b) => b?.demand ?? 0), 0);
      const share = total > 0 ? (demand / total) * 100 : 0;
      if (kept.length < MAX_DEFAULT_OPTIONS && share >= OTHER_FLOOR_PCT) kept.push(v.value);
      else folded = true;
    }
    values = folded ? [...kept, "Other"] : kept;
  } else {
    values = (spec?.top ?? []).slice(0, MAX_DEFAULT_OPTIONS).map(([v]) => v);
  }
  const numeric = values.length > 0 && values.every((v) => /^\d+(\.\d+)?\s*[a-z%]*$/i.test(v));
  const ui_pattern =
    values.length <= 1
      ? "display only"
      : numeric
        ? "range buckets"
        : values.length <= 4
          ? "single-select"
          : "multi-select checkboxes";
  return { values, ui_pattern };
}

/**
 * Fill coverage / top-value share / fill % / sources from the evidence rows the model linked to.
 * Numbers come from code, never from the model. Falls back to matching the filter name.
 */
export function attachEvidence(
  result: FilterResult,
  links: RawLinks[],
  aggregation: Aggregation | null,
  listing: ListingProfile | null,
  demoListings = false,
  uiDesign = true,
): string[] {
  const notes: string[] = [];
  const dims = new Map((aggregation?.dimensions ?? []).map((d) => [norm(d.name), d]));
  const specs = new Map((listing?.fields ?? []).map((f) => [norm(f.key), f]));
  result.filters.forEach((f, i) => {
    const link = links[i] ?? { dimension: null, listing_spec: null, backing: [] };
    let dim = link.dimension ? dims.get(norm(link.dimension)) : undefined;
    if (link.dimension && !dim && aggregation)
      notes.push(
        `"${f.name}" pointed at a keyword dimension "${link.dimension}" that isn't in the evidence; link cleared.`,
      );
    dim ??= dims.get(norm(f.name));
    let spec = link.listing_spec ? specs.get(norm(link.listing_spec)) : undefined;
    if (link.listing_spec && !spec && listing)
      notes.push(
        `"${f.name}" pointed at a listing spec "${link.listing_spec}" that isn't in the evidence; link cleared.`,
      );
    spec ??= specs.get(norm(f.name));
    // Location filters are served by the seller-city field, whatever the filter is called.
    const isPlace = /city|location|near ?me/i.test(`${f.name} ${link.dimension ?? ""}`);
    if (!spec && isPlace)
      spec = (listing?.fields ?? []).find((x) => /\b(city|location)\b/i.test(x.key));
    // Price comes from the listings' price field, not from a spec.
    const isPrice = /price|budget|cost/i.test(`${f.name} ${link.dimension ?? ""}`);

    // "values"/"ui_pattern" are no longer asked of the model (fewer output tokens, faster runs):
    // code derives them from the same evidence the model linked to. A model that still sends its
    // own non-empty values is respected as an override (e.g. a merged/renamed option list).
    if (uiDesign && f.values.length === 0) {
      const derived = deriveOptions(f, dim, spec, listing?.price ?? null, isPrice, isPlace);
      f.values = derived.values;
      f.ui_pattern = derived.ui_pattern;
    }

    const sources: string[] = [];
    if (dim) {
      let best: { coverage: number; topShare: number } | null = null;
      for (const [src, st] of Object.entries(dim.bySource)) {
        if (!st) continue;
        sources.push(src);
        if (!best || st.coverage > best.coverage) best = st;
      }
      f.coverage_pct = best?.coverage ?? null;
      f.top_value_share_pct = best?.topShare ?? null;
    } else {
      f.coverage_pct = null;
      f.top_value_share_pct = null;
    }
    f.listing_fill_pct = spec ? spec.fillPct : null;
    f.linked_dimension = dim?.name ?? null;
    f.linked_listing_spec = spec?.key ?? null;
    // Low supply is kept visible, never silently dropped: make sure the rationale says so.
    if (listing && !isPrice && f.tier !== "Tier 3" && !/fill/i.test(f.rationale)) {
      const where = demoListings ? "sample listings" : "listings";
      if (!spec) f.rationale += ` (not captured in ${where} — needs an ISQ field)`;
      else if (spec.fillPct < 30)
        f.rationale += ` (only ${spec.fillPct}% of ${where} fill this — needs ISQ push)`;
    }
    if (spec) sources.push("listings");
    for (const b of link.backing) if (b === "context" || b === "ranking") sources.push(b);
    f.sources = sources;
  });
  return notes;
}

const MAX_OPTIONS = 12;

/**
 * Deterministic fixes instead of a second (full-price) model call. Returns a note per change so
 * nothing changes silently, plus warnings for what can't be fixed in code.
 */
export function fixResult(
  r: FilterResult,
  uiDesign = true,
): { fixes: string[]; warnings: string[] } {
  const fixes: string[] = [];
  const warnings: string[] = [];
  const confScore: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
  const byTier = (t: Tier) => r.filters.filter((f) => f.tier === t).sort((a, b) => a.rank - b.rank);

  // Duplicates (same normalised name) — keep the first.
  const seen = new Set<string>();
  r.filters = r.filters.filter((f) => {
    const k = norm(f.name);
    if (!k) {
      fixes.push("Removed a filter with no name.");
      return false;
    }
    if (seen.has(k)) {
      fixes.push(`Removed a duplicate "${f.name}".`);
      return false;
    }
    seen.add(k);
    return true;
  });

  for (const f of r.filters) {
    if (!uiDesign) {
      // Filters + tiers only: no options or UI patterns to check.
      f.values = [];
      f.ui_pattern = f.tier === "Tier 3" ? "display only" : "";
      if (
        !/\d/.test(f.rationale) &&
        !/context|interview|ranking|ranked|\bCM\b|listing/i.test(f.rationale)
      )
        warnings.push(`The rationale for "${f.name}" cites no evidence.`);
      continue;
    }
    const junk = f.values.filter((v) => v.length < 2 || /^\d+(\.\d+)?$/.test(v));
    if (junk.length) {
      f.values = f.values.filter((v) => !junk.includes(v));
      fixes.push(`"${f.name}": dropped options that aren't labels (${junk.join(", ")}).`);
    }
    const unique = [...new Map(f.values.map((v) => [v.toLowerCase(), v])).values()];
    if (unique.length !== f.values.length) f.values = unique;
    if (f.values.length > MAX_OPTIONS) {
      const hasOther = f.values.some((v) => /^other/i.test(v));
      f.values = [...f.values.filter((v) => !/^other/i.test(v)).slice(0, MAX_OPTIONS - 1), "Other"];
      fixes.push(
        `"${f.name}": kept the top ${MAX_OPTIONS - 1} options${hasOther ? "" : ' and added "Other"'}.`,
      );
    }
    if (f.tier !== "Tier 3" && f.values.length < 2) {
      f.tier = "Tier 3";
      f.ui_pattern = "display only";
      fixes.push(`"${f.name}" had fewer than 2 options, so it moved to Tier 3 (display only).`);
    }
    if (f.tier === "Tier 3" && !/display/i.test(f.ui_pattern)) f.ui_pattern = "display only";
    if (
      !/\d/.test(f.rationale) &&
      !/context|interview|ranking|ranked|\bCM\b|listing/i.test(f.rationale)
    )
      warnings.push(`The rationale for "${f.name}" cites no evidence.`);
  }

  // Tier 1 size: 3–5.
  const t1 = byTier("Tier 1");
  if (t1.length > 5) {
    for (const f of t1.slice(5)) f.tier = "Tier 2";
    fixes.push(
      `Tier 1 had ${t1.length} filters; moved ${t1
        .slice(5)
        .map((f) => `"${f.name}"`)
        .join(", ")} to Tier 2.`,
    );
  } else if (t1.length < 3) {
    const pool = byTier("Tier 2").sort(
      (a, b) => (confScore[a.confidence] ?? 1) - (confScore[b.confidence] ?? 1) || a.rank - b.rank,
    );
    const promote = pool.slice(0, 3 - t1.length);
    for (const f of promote) f.tier = "Tier 1";
    if (promote.length)
      fixes.push(
        `Tier 1 had ${t1.length} filter(s); promoted ${promote.map((f) => `"${f.name}"`).join(", ")} from Tier 2.`,
      );
  }

  // Renumber ranks 1…n per tier, keeping the model's order (promoted filters go last in Tier 1).
  for (const t of ["Tier 1", "Tier 2", "Tier 3"] as Tier[]) {
    const inTier = r.filters.filter((f) => f.tier === t);
    const original = new Map(inTier.map((f) => [f, f.rank]));
    inTier.sort((a, b) => original.get(a)! - original.get(b)!).forEach((f, i) => (f.rank = i + 1));
  }

  // Every ISQ gap gets a blocker.
  r.blockers ??= [];
  for (const f of r.filters.filter((x) => x.needs_new_isq)) {
    if (!r.blockers.some((b) => b.toLowerCase().includes(f.name.toLowerCase()))) {
      r.blockers.push(
        `${f.name}: ${f.isq_note || "not captured on listings — add it to the seller form."}`,
      );
      fixes.push(`Added a blocker for "${f.name}" (needs a new ISQ).`);
    }
  }
  return { fixes, warnings };
}

// ───────────────────────────── run ─────────────────────────────

interface RunHooks {
  onStep: (id: StepId, patch: Partial<Step>) => void;
  signal?: AbortSignal;
  /**
   * Re-run from this step: model answers for this step and the ones after it are asked for again;
   * earlier steps reuse their cached answers. Default "prepare" with the cache on (a normal run).
   */
  from?: StepId;
}

const pctOf = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");

export async function runPipeline(
  settings: LlmSettings,
  inputs: PipelineInputs,
  hooks: RunHooks,
): Promise<PipelineRun> {
  const { onStep, signal, from } = hooks;
  // Re-running from a step asks the model afresh for that step (from "prepare": for every step).
  // Labelling and spec merging don't depend on each other; the design step is always asked afresh
  // unless the re-run starts at the check step.
  const fresh = (id: "label" | "fields") => from === id || from === "prepare";
  // Small tasks don't need reasoning; the design step gets real reasoning room (skill 08 is a
  // 7-step method applied per candidate, and a richer rationale needs room to think it through).
  const opts = (maxTokens: number, reasoning: "off" | "low" | "medium") =>
    signal ? { maxTokens, reasoning, signal } : { maxTokens, reasoning };
  let usage: Usage = {};
  let calls = 0;
  const prompts: PromptRecord[] = [];
  const warnings: string[] = [];

  const started: Partial<Record<StepId, number>> = {};
  const step = (id: StepId, status: StepStatus, patch: Partial<Step> = {}) => {
    const now = performance.now();
    if (status === "running") started[id] = now;
    const ms =
      status !== "running" && started[id] !== undefined
        ? Math.round(now - started[id]!)
        : undefined;
    onStep(id, { status, ...(ms !== undefined ? { ms } : {}), ...patch });
  };

  // 1 · deterministic prep
  step("prepare", "running");
  const prep = prepare(inputs);
  const kwCount = prep.tables.reduce((s, t) => s + t.rows.length, 0);
  const auto = prep.mining ? alignAutoLabels(autoLabels(prep.mining), prep.dims) : [];
  {
    const bySource = (src: string) => prep.tables.find((t) => t.source === src)?.rows.length ?? 0;
    const stats: StepStat[] = [];
    if (kwCount) {
      if (bySource("internal"))
        stats.push({ label: "internal keywords", value: bySource("internal") });
      if (bySource("serp")) stats.push({ label: "SERP keywords", value: bySource("serp") });
      stats.push(
        { label: "terms mined", value: prep.mining?.terms.length ?? 0 },
        { label: "labelled by code", value: auto.length },
        { label: "terms for the model", value: prep.modelTerms.length },
      );
    }
    if (prep.flatListings.length)
      stats.push(
        { label: "listings", value: prep.flatListings.length },
        { label: "spec fields", value: prep.specs.length },
      );
    stats.push(
      { label: "dimension names", value: prep.dims.ranking.length + prep.dims.listing.length },
      { label: "context chars", value: inputs.context.length },
    );
    const inputLines = [
      ...prep.tables.map(
        (t) =>
          `${t.source} keywords: ${t.rows.length} rows · query column "${t.queryColumn ?? "?"}" · demand "${t.demandMetric ?? "none"}" · action "${t.actionMetric ?? "none"}"${t.rateMetrics.length ? ` · rates ${t.rateMetrics.join(", ")}` : ""}`,
      ),
      `context document: ${inputs.context.length.toLocaleString()} characters`,
      `spec ranking: ${inputs.specs.trim() ? inputs.specs.trim().split(/\n/).length + " line(s)" : "none"}`,
      `listings: ${inputs.listingRows.length} row(s)${inputs.listingRows.length > 500 ? " (first 500 used)" : ""}`,
    ];
    const outputLines = [
      prep.mining ? `Core category words: ${prep.mining.coreTerms.join(", ") || "none"}` : "",
      auto.length
        ? `Labelled by code (${auto.length}):\n${auto
            .slice(0, 60)
            .map((l) => `  ${l.term} → ${l.dimension} = ${l.value}`)
            .join("\n")}${auto.length > 60 ? `\n  … ${auto.length - 60} more` : ""}`
        : "",
      prep.modelTerms.length
        ? `Terms left for the model (${prep.modelTerms.length}): ${prep.modelTerms
            .slice(0, 40)
            .map((t) => t.term)
            .join(", ")}${prep.modelTerms.length > 40 ? ", …" : ""}`
        : "",
      prep.dims.ranking.length
        ? `Dimensions from the ranking: ${prep.dims.ranking.join(", ")}`
        : "",
      prep.dims.listing.length
        ? `Dimensions from listing specs: ${prep.dims.listing
            .slice(0, 30)
            .map((d) => `${d.name} (${d.fillPct}%)`)
            .join(", ")}`
        : "",
      prep.specs.length
        ? `Spec fields detected (${prep.specs.length}):\n${prep.specs
            .slice(0, 40)
            .map((sp) => `  ${sp.spec} · filled ${sp.fillPct}% · e.g. ${sp.samples.join(", ")}`)
            .join("\n")}`
        : "",
    ].filter(Boolean);
    step("prepare", "done", {
      calls: 0,
      detail: [
        kwCount
          ? `${kwCount.toLocaleString()} keywords · ${auto.length} terms labelled by code`
          : "no keywords",
        prep.flatListings.length ? `${prep.flatListings.length} listings` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      stats,
      input: inputLines.join("\n"),
      output: outputLines.join("\n\n"),
    });
  }

  /**
   * One model step: reuses this session's cached answer when allowed, and re-sends the prompt in
   * compact form if the provider says it's too long for the model.
   */
  const ask = async (
    id: "label" | "fields" | "design",
    title: string,
    build: (budget: PromptBudget) => ChatMessage[],
    maxTokens: number,
    reasoning: "off" | "low" | "medium",
    reuse: boolean,
  ) => {
    let compact = false;
    const out = await withBudget(
      async (budget) => {
        const messages = build(budget);
        onStep(id, { input: messagesText(messages) });
        const key = cacheKey(settings, messages);
        const hit = reuse ? stageCache.get(key) : undefined;
        if (hit !== undefined) return { data: hit, cached: true, usage: {} as Usage, messages };
        const res = await chatJson<unknown>(settings, messages, opts(maxTokens, reasoning));
        usage = addUsage(usage, res.usage);
        calls++;
        remember(key, res.data);
        return { data: res.data, cached: false, usage: res.usage, messages };
      },
      () => {
        compact = true;
        warnings.push(COMPACT_NOTE(STEP_NAME[id]));
      },
    );
    prompts.push({ id, stage: id, title, messages: out.messages });
    return { ...out, compact };
  };
  const compactTag = (c: boolean) => (c ? " · compact prompt" : "");

  // 2 + 3 · labelling and spec-name merging run in parallel
  const labelTask = async (): Promise<{ labels: TermLabel[]; category: string | null }> => {
    if (!prep.mining || prep.modelTerms.length === 0) {
      step("label", "skipped", {
        calls: 0,
        detail: prep.mining ? "all terms labelled by code" : "no keyword data",
      });
      return { labels: auto, category: null };
    }
    const known = new Set(prep.modelTerms.map((t) => t.term));
    step("label", "running");
    try {
      const {
        data,
        cached,
        usage: stepUsage,
        compact,
      } = await ask(
        "label",
        "1 · Label keyword terms",
        (b) => labelMessages(prep, b),
        Math.min(2500, 400 + prep.modelTerms.length * 10),
        "off",
        !fresh("label"),
      );
      const labels = parseLabels(data, known);
      const dims = new Set(labels.map((l) => l.dimension));
      const category = (data as any)?.category_name;
      step("label", "done", {
        calls: cached ? 0 : 1,
        cached,
        usage: stepUsage,
        detail: `${labels.length} of ${prep.modelTerms.length} terms labelled · ${auto.length} by code${cached ? " · reused (no cost)" : ""}${compactTag(compact)}`,
        stats: [
          { label: "terms sent", value: prep.modelTerms.length },
          { label: "labelled", value: labels.length },
          { label: "left unlabelled", value: prep.modelTerms.length - labels.length },
          { label: "labelled share", value: pctOf(labels.length, prep.modelTerms.length) },
          { label: "dimensions used", value: dims.size },
          { label: "labelled by code", value: auto.length },
          ...(typeof category === "string" && category
            ? [{ label: "category", value: category }]
            : []),
        ],
        output: JSON.stringify(data, null, 2),
      });
      return {
        labels: [...auto, ...labels],
        category: typeof category === "string" ? category : null,
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      warnings.push(
        `Term labelling failed (${(err as Error).message}); only code-labelled terms (price, location, size) were grouped.`,
      );
      step("label", "error", {
        detail: "used code labels only",
        output: (err as Error).message,
      });
      return { labels: auto, category: null };
    }
  };

  const profileStats = (profile: ListingProfile): StepStat[] => [
    { label: "specs kept", value: profile.fields.length },
    {
      label: "filled on ≥ 50%",
      value: profile.fields.filter((f) => f.fillPct >= 50).length,
    },
    { label: "priced listings", value: profile.price?.n ?? 0 },
  ];
  const profileText = (profile: ListingProfile) =>
    `Listing spec profile (${profile.count} listings):\n${profile.fields
      .slice(0, 40)
      .map(
        (f) =>
          `  ${f.key} · filled ${f.fillPct}% · ${f.distinct} values · ${f.top
            .slice(0, 5)
            .map(([v]) => v)
            .join(", ")}`,
      )
      .join("\n")}`;

  const fieldTask = async (): Promise<ListingProfile | null> => {
    if (prep.flatListings.length === 0) {
      step("fields", "skipped", { calls: 0, detail: "no listings" });
      return null;
    }
    if (!needsFieldCall(prep)) {
      const profile = profileListings(prep.flatListings, prep.fieldMap);
      step("fields", "skipped", {
        calls: 0,
        detail: "mapped by code",
        stats: profileStats(profile),
        output: profileText(profile),
      });
      return profile;
    }
    step("fields", "running");
    try {
      const {
        data,
        cached,
        usage: stepUsage,
        compact,
      } = await ask(
        "fields",
        "2 · Merge listing spec names",
        (b) => fieldMessages(prep, b),
        1000,
        "off",
        !fresh("fields"),
      );
      const { map, changes } = applySpecMerges(prep.fieldMap, data);
      const profile = profileListings(prep.flatListings, map);
      step("fields", "done", {
        calls: cached ? 0 : 1,
        cached,
        usage: stepUsage,
        detail: `${profile.fields.length} specs · ${changes} field(s) merged or dropped${cached ? " · reused (no cost)" : ""}${compactTag(compact)}`,
        stats: [
          { label: "spec names sent", value: prep.specs.length },
          { label: "merged or dropped", value: changes },
          ...profileStats(profile),
        ],
        output: `${JSON.stringify(data, null, 2)}\n\n${profileText(profile)}`,
      });
      return profile;
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      warnings.push(
        `Spec-name merging failed (${(err as Error).message}); the code-only field mapping was used.`,
      );
      step("fields", "error", { detail: "used code mapping", output: (err as Error).message });
      return profileListings(prep.flatListings, prep.fieldMap);
    }
  };

  const [{ labels, category }, listing] = await Promise.all([labelTask(), fieldTask()]);
  const aggregation = labels.length ? aggregate(prep.tables, labels) : null;
  const evidence: Evidence = {
    category,
    tables: prep.tables,
    mining: prep.mining,
    labels,
    aggregation,
    listing,
  };

  // 4 · design
  const uiDesign = inputs.uiDesign !== false;
  const designMessages = (budget: PromptBudget): ChatMessage[] => [
    { role: "system", content: uiDesign ? FILTER_DESIGN_SYSTEM : FILTER_DESIGN_SYSTEM_NO_UI },
    {
      role: "user",
      content: buildDesignUser({
        category,
        tables: prep.tables,
        mining: prep.mining,
        aggregation,
        context: inputs.context,
        specs: inputs.specs,
        listing,
        demoListings: Boolean(inputs.demoListings),
        uiDesign,
        budget,
      }),
    },
  ];
  step("design", "running");
  // The design answer is only reused when re-running from the check step.
  const {
    data: designData,
    cached: designCached,
    usage: designUsage,
    compact: designCompact,
  } = await ask(
    "design",
    "3 · Master prompt — design the filter panel",
    designMessages,
    // No model-authored options/UI pattern (skill 09) frees up room that goes toward reasoning
    // depth instead: richer, multi-part rationale and more specific interaction rules (skill 10)
    // read better than a terse answer, so this is sized generously rather than minimised.
    uiDesign ? 3200 : 2200,
    "medium",
    from === "check",
  );
  const { result, links } = normalizeResult(designData);
  if (result.filters.length === 0) {
    step("design", "error", {
      detail: "no filters returned",
      output: JSON.stringify(designData, null, 2),
    });
    throw new Error("The model returned no filters. Try again or pick another model.");
  }
  const tierN = (t: Tier) => result.filters.filter((f) => f.tier === t).length;
  step("design", "done", {
    calls: designCached ? 0 : 1,
    cached: designCached,
    usage: designUsage,
    detail: `${result.filters.length} filters proposed${designCached ? " · reused (no cost)" : ""}${compactTag(designCompact)}`,
    stats: [
      { label: "filters", value: result.filters.length },
      { label: "Tier 1", value: tierN("Tier 1") },
      { label: "Tier 2", value: tierN("Tier 2") },
      { label: "Tier 3", value: tierN("Tier 3") },
      { label: "linked to a dimension", value: links.filter((l) => l.dimension).length },
      { label: "linked to a listing spec", value: links.filter((l) => l.listing_spec).length },
      { label: "evidence tables sent", value: aggregation?.dimensions.length ?? 0 },
    ],
    output: JSON.stringify(designData, null, 2),
  });

  // 5 · link evidence and fix in code (no second model call)
  step("check", "running");
  const linkNotes = attachEvidence(
    result,
    links,
    aggregation,
    listing,
    inputs.demoListings,
    inputs.uiDesign !== false,
  );
  const { fixes, warnings: left } = fixResult(result, inputs.uiDesign !== false);
  if (inputs.uiDesign === false) result.interaction_rules = [];
  warnings.push(...fixes.map((f) => `Auto-fixed: ${f}`), ...linkNotes, ...left);
  step("check", "done", {
    calls: 0,
    detail: fixes.length ? `${fixes.length} auto-fix(es)` : "all checks passed",
    stats: [
      { label: "auto-fixes", value: fixes.length },
      { label: "evidence notes", value: linkNotes.length },
      { label: "open warnings", value: left.length },
      {
        label: "with coverage",
        value: result.filters.filter((f) => f.coverage_pct != null).length,
      },
      {
        label: "with fill rate",
        value: result.filters.filter((f) => f.listing_fill_pct != null).length,
      },
      { label: "needs new ISQ", value: result.filters.filter((f) => f.needs_new_isq).length },
    ],
    input: `${result.filters.length} filters from the design step, with ${links.length} evidence link(s).`,
    output:
      [
        fixes.length
          ? `Auto-fixes:\n${fixes.map((f) => `  • ${f}`).join("\n")}`
          : "No fixes needed.",
        linkNotes.length ? `Evidence notes:\n${linkNotes.map((f) => `  • ${f}`).join("\n")}` : "",
        left.length ? `Still open:\n${left.map((f) => `  • ${f}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n") +
      `\n\nFinal filters:\n${result.filters
        .map(
          (f) =>
            `  ${f.tier} #${f.rank} ${f.name}${f.coverage_pct != null ? ` · coverage ${f.coverage_pct}%` : ""}${f.listing_fill_pct != null ? ` · filled ${f.listing_fill_pct}%` : ""}`,
        )
        .join("\n")}`,
  });

  if (!result.category_name && category) result.category_name = category;
  result.total_keywords_analyzed = kwCount;
  return { result, evidence, warnings, usage, calls, prompts };
}

// ───────────────────────────── cost estimate ─────────────────────────────

export interface RunEstimate {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Tokens a run will use with the current inputs: prompt sizes from the real prompts (≈ 4 chars/token),
 * output from how much each step writes back (grouped labels, merges, ~120 tokens per filter).
 */
export function estimateRun(prompts: PromptRecord[]): RunEstimate {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const p of prompts) {
    const chars = p.messages.reduce((n, m) => n + m.content.length, 0);
    inputTokens += Math.ceil(chars / 4);
    const userLines = (p.messages[1]?.content.match(/\n/g) ?? []).length;
    if (p.id === "label") outputTokens += 60 + userLines * 7;
    else if (p.id === "fields") outputTokens += 40 + userLines * 4;
    else if (p.id === "design")
      // No model-authored options/UI pattern (skill 09), but rationale is now 2-3 sentences with
      // three required parts, interaction_rules are more detailed, and the model has room for a
      // brief reasoning pass per candidate (skill 08) — sized for that, not for minimum output.
      outputTokens += p.messages[1]?.content.includes("UI DESIGN IS SWITCHED OFF") ? 1400 : 2200;
  }
  // The design step's evidence grows once step 1's labels are added.
  if (prompts.some((p) => p.id === "label")) inputTokens += 600;
  return { calls: prompts.length, inputTokens, outputTokens };
}
