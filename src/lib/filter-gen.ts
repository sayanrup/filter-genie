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
  type KeywordTable,
  type ListingProfile,
  type Row,
  type TermLabel,
  type TermMining,
  type TermStat,
  type DimensionCandidates,
} from "./data";
import { addUsage, chatJson, type ChatMessage, type LlmSettings, type Usage } from "./llm";
import {
  FIELD_MAP_SYSTEM,
  FILTER_DESIGN_SYSTEM,
  FILTER_DESIGN_SYSTEM_NO_UI,
  TERM_LABEL_SYSTEM,
  buildDesignUser,
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

export interface Step {
  id: StepId;
  label: string;
  status: StepStatus;
  detail?: string;
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
  { id: "prepare", label: "Read & total the data", status: "pending" },
  { id: "label", label: "Label keyword terms", status: "pending" },
  { id: "fields", label: "Map listing fields", status: "pending" },
  { id: "design", label: "Design the filter panel", status: "pending" },
  { id: "check", label: "Check & fix output", status: "pending" },
];

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

function labelMessages(prep: Prepared): ChatMessage[] {
  return [
    { role: "system", content: TERM_LABEL_SYSTEM },
    {
      role: "user",
      content: buildTermLabelUser(prep.modelTerms, prep.mining!, prep.dims, prep.context),
    },
  ];
}

function fieldMessages(prep: Prepared): ChatMessage[] {
  return [
    { role: "system", content: FIELD_MAP_SYSTEM },
    { role: "user", content: buildFieldMapUser(prep.specs, prep.flatListings.length) },
  ];
}

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
  onStep: (id: StepId, status: StepStatus, detail?: string) => void;
  signal?: AbortSignal;
}

export async function runPipeline(
  settings: LlmSettings,
  inputs: PipelineInputs,
  hooks: RunHooks,
): Promise<PipelineRun> {
  const { onStep, signal } = hooks;
  // Small tasks don't need reasoning; the design step gets a little.
  const opts = (maxTokens: number, reasoning: "off" | "low") =>
    signal ? { maxTokens, reasoning, signal } : { maxTokens, reasoning };
  let usage: Usage = {};
  let calls = 0;
  const prompts: PromptRecord[] = [];
  const warnings: string[] = [];

  // 1 · deterministic prep
  onStep("prepare", "running");
  const prep = prepare(inputs);
  const kwCount = prep.tables.reduce((s, t) => s + t.rows.length, 0);
  const auto = prep.mining ? alignAutoLabels(autoLabels(prep.mining), prep.dims) : [];
  onStep(
    "prepare",
    "done",
    [
      kwCount
        ? `${kwCount.toLocaleString()} keywords · ${auto.length} terms labelled by code`
        : "no keywords",
      prep.flatListings.length ? `${prep.flatListings.length} listings` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );

  // 2 + 3 · labelling and spec-name merging run in parallel
  const labelTask = async (): Promise<{ labels: TermLabel[]; category: string | null }> => {
    if (!prep.mining || prep.modelTerms.length === 0) {
      onStep("label", "skipped", prep.mining ? "all terms labelled by code" : "no keyword data");
      return { labels: auto, category: null };
    }
    const messages = labelMessages(prep);
    prompts.push({ id: "label", stage: "label", title: "1 · Label keyword terms", messages });
    const key = cacheKey(settings, messages);
    const known = new Set(prep.modelTerms.map((t) => t.term));
    try {
      let data = stageCache.get(key);
      const cached = Boolean(data);
      if (!cached) {
        onStep("label", "running");
        const res = await chatJson<unknown>(settings, messages, opts(2500, "off"));
        usage = addUsage(usage, res.usage);
        calls++;
        data = res.data;
        remember(key, data);
      }
      const labels = parseLabels(data, known);
      onStep(
        "label",
        "done",
        `${labels.length} of ${prep.modelTerms.length} terms labelled · ${auto.length} by code${cached ? " · reused (no cost)" : ""}`,
      );
      const category = (data as any)?.category_name;
      return {
        labels: [...auto, ...labels],
        category: typeof category === "string" ? category : null,
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      warnings.push(
        `Term labelling failed (${(err as Error).message}); only code-labelled terms (price, location, size) were grouped.`,
      );
      onStep("label", "error", "used code labels only");
      return { labels: auto, category: null };
    }
  };

  const fieldTask = async (): Promise<ListingProfile | null> => {
    if (prep.flatListings.length === 0) {
      onStep("fields", "skipped", "no listings");
      return null;
    }
    if (!needsFieldCall(prep)) {
      onStep("fields", "skipped", "mapped by code");
      return profileListings(prep.flatListings, prep.fieldMap);
    }
    const messages = fieldMessages(prep);
    prompts.push({
      id: "fields",
      stage: "fields",
      title: "2 · Merge listing spec names",
      messages,
    });
    const key = cacheKey(settings, messages);
    try {
      let data = stageCache.get(key);
      const cached = Boolean(data);
      if (!cached) {
        onStep("fields", "running");
        const res = await chatJson<unknown>(settings, messages, opts(1500, "off"));
        usage = addUsage(usage, res.usage);
        calls++;
        data = res.data;
        remember(key, data);
      }
      const { map, changes } = applySpecMerges(prep.fieldMap, data);
      const profile = profileListings(prep.flatListings, map);
      onStep(
        "fields",
        "done",
        `${profile.fields.length} specs · ${changes} field(s) merged or dropped${cached ? " · reused (no cost)" : ""}`,
      );
      return profile;
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      warnings.push(
        `Spec-name merging failed (${(err as Error).message}); the code-only field mapping was used.`,
      );
      onStep("fields", "error", "used code mapping");
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
  onStep("design", "running");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: inputs.uiDesign === false ? FILTER_DESIGN_SYSTEM_NO_UI : FILTER_DESIGN_SYSTEM,
    },
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
        uiDesign: inputs.uiDesign !== false,
      }),
    },
  ];
  prompts.push({
    id: "design",
    stage: "design",
    title: "3 · Master prompt — design the filter panel",
    messages,
  });
  const design = await chatJson<unknown>(settings, messages, opts(6000, "low"));
  usage = addUsage(usage, design.usage);
  calls++;
  const { result, links } = normalizeResult(design.data);
  if (result.filters.length === 0)
    throw new Error("The model returned no filters. Try again or pick another model.");
  onStep("design", "done", `${result.filters.length} filters proposed`);

  // 5 · link evidence and fix in code (no second model call)
  onStep("check", "running");
  const linkNotes = attachEvidence(result, links, aggregation, listing, inputs.demoListings);
  const { fixes, warnings: left } = fixResult(result, inputs.uiDesign !== false);
  if (inputs.uiDesign === false) result.interaction_rules = [];
  warnings.push(...fixes.map((f) => `Auto-fixed: ${f}`), ...linkNotes, ...left);
  onStep("check", "done", fixes.length ? `${fixes.length} auto-fix(es)` : "all checks passed");

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
      outputTokens += p.messages[1]?.content.includes("UI DESIGN IS SWITCHED OFF") ? 1000 : 1800;
  }
  // The design step's evidence grows once step 1's labels are added.
  if (prompts.some((p) => p.id === "label")) inputTokens += 600;
  return { calls: prompts.length, inputTokens, outputTokens };
}
