/* eslint-disable @typescript-eslint/no-explicit-any -- model replies are untyped JSON and are normalised field by field */
import {
  aggregate,
  flattenListing,
  mineTerms,
  profileListings,
  rawFieldSummary,
  toKeywordTable,
  type Aggregation,
  type KeywordTable,
  type ListingProfile,
  type Row,
  type TermLabel,
  type TermMining,
} from "./data";
import { addUsage, chatJson, type ChatMessage, type LlmSettings, type Usage } from "./llm";
import {
  FIELD_MAP_SYSTEM,
  FILTER_DESIGN_SYSTEM,
  TERM_LABEL_SYSTEM,
  buildDesignUser,
  buildFieldMapUser,
  buildRepairUser,
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
  { id: "check", label: "Check & repair output", status: "pending" },
];

// ───────────────────────────── deterministic prep ─────────────────────────────

export interface Prepared {
  tables: KeywordTable[];
  mining: TermMining | null;
  flatListings: Record<string, string>[];
}

export function prepare(inputs: PipelineInputs): Prepared {
  const tables = [
    toKeywordTable(inputs.internalRows, "internal"),
    toKeywordTable(inputs.serpRows, "serp"),
  ].filter((t): t is KeywordTable => t !== null && t.rows.length > 0);
  const mining = tables.length ? mineTerms(tables) : null;
  const flatListings = inputs.listingRows.slice(0, 500).map((r) => flattenListing(r));
  return { tables, mining, flatListings };
}

/** Prompts as they'd be sent, before any model call (for the "View prompts" panel). */
export function previewPrompts(inputs: PipelineInputs): PromptRecord[] {
  const prep = prepare(inputs);
  const out: PromptRecord[] = [];
  if (prep.mining && prep.mining.terms.length) {
    out.push({
      id: "label",
      stage: "label",
      title: "1 · Label keyword terms",
      messages: [
        { role: "system", content: TERM_LABEL_SYSTEM },
        { role: "user", content: buildTermLabelUser(prep.tables, prep.mining) },
      ],
    });
  }
  if (prep.flatListings.length) {
    out.push({
      id: "fields",
      stage: "fields",
      title: "2 · Map listing fields",
      messages: [
        { role: "system", content: FIELD_MAP_SYSTEM },
        {
          role: "user",
          content: buildFieldMapUser(rawFieldSummary(prep.flatListings), prep.flatListings.length),
        },
      ],
    });
  }
  out.push({
    id: "design",
    stage: "design",
    title: "3 · Master prompt — design the filter panel",
    messages: [
      { role: "system", content: FILTER_DESIGN_SYSTEM },
      {
        role: "user",
        content: buildDesignUser({
          category: null,
          tables: prep.tables,
          mining: prep.mining,
          aggregation: null,
          context: inputs.context,
          specs: inputs.specs,
          listing: prep.flatListings.length ? profileListings(prep.flatListings) : null,
        }).concat(
          prep.mining
            ? "\n\n[Preview: at run time the keyword section is replaced by the dimension/value tables built from step 1's labels.]"
            : "",
        ),
      },
    ],
  });
  return out;
}

// ───────────────────────────── validation ─────────────────────────────

const TIER_ALIASES: Record<string, Tier> = { "1": "Tier 1", "2": "Tier 2", "3": "Tier 3" };

function normalizeResult(raw: any): FilterResult {
  const filters: FilterRow[] = (Array.isArray(raw?.filters) ? raw.filters : []).map(
    (f: any, i: number) => {
      const tierDigit = String(f?.tier ?? "").match(/[123]/)?.[0] ?? "2";
      const conf = String(f?.confidence ?? "").toLowerCase();
      const num = (v: unknown) =>
        typeof v === "number" && Number.isFinite(v)
          ? v
          : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))
            ? Number(v)
            : null;
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
        sources: Array.isArray(f?.sources) ? f.sources.map(String) : [],
        coverage_pct: num(f?.coverage_pct),
        top_value_share_pct: num(f?.top_value_share_pct),
        listing_fill_pct: num(f?.listing_fill_pct),
        needs_new_isq: Boolean(f?.needs_new_isq),
        isq_note: f?.isq_note ? String(f.isq_note) : null,
      };
    },
  );
  const out: FilterResult = {
    filters,
    interaction_rules: Array.isArray(raw?.interaction_rules)
      ? raw.interaction_rules.map(String)
      : [],
    blockers: Array.isArray(raw?.blockers) ? raw.blockers.map(String) : [],
  };
  if (raw?.category_name) out.category_name = String(raw.category_name);
  return out;
}

export function validateResult(r: FilterResult): string[] {
  const issues: string[] = [];
  if (r.filters.length === 0) return ['"filters" is empty.'];
  const t1 = r.filters.filter((f) => f.tier === "Tier 1");
  const filterable = r.filters.filter((f) => f.tier !== "Tier 3").length;
  if (t1.length > 5)
    issues.push(`Tier 1 has ${t1.length} filters; the maximum is 5. Move the weakest to Tier 2.`);
  if (t1.length < 3 && filterable >= 3)
    issues.push(
      `Tier 1 has only ${t1.length} filter(s); it needs 3–5. Promote the strongest Tier 2 filters.`,
    );

  const seen = new Map<string, number>();
  for (const f of r.filters) {
    const key = f.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (!f.name) issues.push("A filter has no name.");
    if (f.tier !== "Tier 3" && f.values.length < 2)
      issues.push(
        `"${f.name}" (${f.tier}) has ${f.values.length} option(s); filters need at least 2 real options.`,
      );
    if (f.values.length > 15)
      issues.push(
        `"${f.name}" has ${f.values.length} options; cap at ~10 and fold the tail into "Other".`,
      );
    const junk = f.values.filter((v) => v.length < 2 || /^\d+$/.test(v));
    if (junk.length)
      issues.push(
        `"${f.name}" has options that aren't real labels: ${junk.map((j) => JSON.stringify(j)).join(", ")}.`,
      );
    if (!/\d/.test(f.rationale) && !/context|interview|ranking|ranked|CM\b/i.test(f.rationale))
      issues.push(
        `The rationale for "${f.name}" cites no evidence (no number and no named source).`,
      );
    if (f.tier === "Tier 3" && !/display/i.test(f.ui_pattern))
      issues.push(`"${f.name}" is Tier 3, so its ui_pattern must be "display only".`);
  }
  for (const [k, n] of seen)
    if (n > 1 && k) issues.push(`More than one filter is named like "${k}"; merge duplicates.`);
  return issues;
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
  const opts = (maxTokens: number) => (signal ? { maxTokens, signal } : { maxTokens });
  let usage: Usage = {};
  let calls = 0;
  const prompts: PromptRecord[] = [];
  const warnings: string[] = [];

  // 1 · deterministic prep
  onStep("prepare", "running");
  const prep = prepare(inputs);
  const kwCount = prep.tables.reduce((s, t) => s + t.rows.length, 0);
  onStep(
    "prepare",
    "done",
    [
      kwCount
        ? `${kwCount.toLocaleString()} keywords, ${prep.mining?.terms.length ?? 0} terms`
        : "no keywords",
      prep.flatListings.length ? `${prep.flatListings.length} listings` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );

  // 2 + 3 · labelling and field mapping run in parallel
  const labelTask = async (): Promise<{ labels: TermLabel[]; category: string | null }> => {
    if (!prep.mining || prep.mining.terms.length === 0) {
      onStep("label", "skipped", "no keyword data");
      return { labels: [], category: null };
    }
    onStep("label", "running");
    const messages: ChatMessage[] = [
      { role: "system", content: TERM_LABEL_SYSTEM },
      { role: "user", content: buildTermLabelUser(prep.tables, prep.mining) },
    ];
    prompts.push({ id: "label", stage: "label", title: "1 · Label keyword terms", messages });
    try {
      const res = await chatJson<{ category_name?: string; labels?: unknown[] }>(
        settings,
        messages,
        opts(6000),
      );
      usage = addUsage(usage, res.usage);
      calls++;
      const known = new Set(prep.mining.terms.map((t) => t.term));
      const labels: TermLabel[] = (res.data.labels ?? [])
        .map((l) =>
          Array.isArray(l) ? l : [(l as any)?.term, (l as any)?.dimension, (l as any)?.value],
        )
        .filter(
          (l) => typeof l[0] === "string" && typeof l[1] === "string" && typeof l[2] === "string",
        )
        .map((l) => ({
          term: String(l[0]).toLowerCase().trim(),
          dimension: String(l[1]).trim(),
          value: String(l[2]).trim(),
        }))
        .filter((l) => known.has(l.term) && l.dimension && l.value);
      onStep("label", "done", `${labels.length} of ${prep.mining.terms.length} terms labelled`);
      return { labels, category: res.data.category_name ?? null };
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      warnings.push(
        `Term labelling failed (${(err as Error).message}); the design step used raw term totals instead.`,
      );
      onStep("label", "error", "fell back to raw term totals");
      return { labels: [], category: null };
    }
  };

  const fieldTask = async (): Promise<ListingProfile | null> => {
    if (prep.flatListings.length === 0) {
      onStep("fields", "skipped", "no listings");
      return null;
    }
    onStep("fields", "running");
    const summary = rawFieldSummary(prep.flatListings);
    const messages: ChatMessage[] = [
      { role: "system", content: FIELD_MAP_SYSTEM },
      { role: "user", content: buildFieldMapUser(summary, prep.flatListings.length) },
    ];
    prompts.push({ id: "fields", stage: "fields", title: "2 · Map listing fields", messages });
    try {
      const res = await chatJson<{ fields?: unknown[] }>(settings, messages, opts(4000));
      usage = addUsage(usage, res.usage);
      calls++;
      const mapping = new Map<string, string>();
      for (const f of res.data.fields ?? []) {
        const pair = Array.isArray(f) ? f : [(f as any)?.source, (f as any)?.target];
        if (typeof pair[0] === "string" && typeof pair[1] === "string")
          mapping.set(pair[0], pair[1].trim());
      }
      if (mapping.size === 0) throw new Error("no field mapping returned");
      const profile = profileListings(prep.flatListings, mapping);
      onStep("fields", "done", `${profile.fields.length} specs from ${summary.length} fields`);
      return profile;
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      warnings.push(
        `Listing field mapping failed (${(err as Error).message}); raw field names were profiled instead.`,
      );
      onStep("fields", "error", "profiled raw field names");
      return profileListings(prep.flatListings);
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
  let messages: ChatMessage[] = [
    { role: "system", content: FILTER_DESIGN_SYSTEM },
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
      }),
    },
  ];
  prompts.push({
    id: "design",
    stage: "design",
    title: "3 · Master prompt — design the filter panel",
    messages,
  });
  const design = await chatJson<unknown>(settings, messages, opts(8000));
  usage = addUsage(usage, design.usage);
  calls++;
  messages = design.messages;
  let result = normalizeResult(design.data);
  onStep("design", "done", `${result.filters.length} filters proposed`);

  // 5 · validate, one repair round if needed
  onStep("check", "running");
  let issues = validateResult(result);
  if (issues.length) {
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: buildRepairUser(issues) },
    ];
    prompts.push({ id: "repair", title: "4 · Repair turn", messages: repairMessages });
    try {
      const fixed = await chatJson<unknown>(settings, repairMessages, opts(8000));
      usage = addUsage(usage, fixed.usage);
      calls++;
      const candidate = normalizeResult(fixed.data);
      const remaining = validateResult(candidate);
      if (candidate.filters.length && remaining.length <= issues.length) {
        result = candidate;
        issues = remaining;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
    }
  }
  warnings.push(...issues);
  onStep("check", "done", issues.length ? `${issues.length} issue(s) left` : "all checks passed");

  if (!result.category_name && category) result.category_name = category;
  result.total_keywords_analyzed = kwCount;
  return { result, evidence, warnings, usage, calls, prompts };
}
