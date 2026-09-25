import { createFileRoute } from "@tanstack/react-router";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { InputPanel } from "@/components/InputPanel";
import {
  SOURCE_LABEL,
  describeKeywordTable,
  fileToRows,
  flattenListing,
  heuristicFieldMap,
  specSummary,
  textToRows,
  toKeywordTable,
  type Row,
} from "@/lib/data";
import {
  DEFAULT_BASE_URLS,
  INITIAL_STEPS,
  MODEL_PRESETS,
  USD_TO_INR,
  chat,
  EST_RUN_TOKENS,
  estimateRun,
  previewPrompts,
  runCostInr,
  runPipeline,
  type FilterRow,
  type LlmSettings,
  type PipelineInputs,
  type PipelineRun,
  type PromptRecord,
  type Provider,
  type StepId,
} from "@/lib/filter-gen";
import { SKILLS, stageSkills } from "@/skills";
import { StepCards, type StepView } from "@/components/StepCards";
import { SearchPreview } from "@/components/SearchPreview";
import { FilterDetailRow } from "@/components/FilterDetail";
import { buildMarkdown, slugify, type InputBundle } from "@/lib/export";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Search Filter Generator — turn keyword data into filter specs" },
      {
        name: "description",
        content:
          "Drop or paste keyword, context and listing data and get a tiered, evidence-backed set of search page filters, powered by your own OpenRouter or LiteLLM key.",
      },
      { property: "og:title", content: "Search Filter Generator" },
      {
        property: "og:description",
        content:
          "Turn SERP keywords, internal search data and category research into a ranked, tiered set of recommended search filters.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Status = { kind: "ok" | "error" | "busy"; message: string } | null;

const STORAGE_KEY = "filter-gen-settings";

const SAVED_KEY = "filter-gen-saved";

type Tab = "table" | "preview" | "evidence" | "raw";
type Device = "desktop" | "mobile";

interface SavedRun {
  id: string;
  name: string;
  savedAt: string;
  model: string;
  result: PipelineRun["result"];
  inputs: InputBundle;
  tab?: Tab;
  device?: Device;
}

const EMPTY_BUNDLE: InputBundle = { serp: "", internal: "", context: "", specs: "", products: "" };

function rowsFromBundle(json: string): Row[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Row[]) : null;
  } catch {
    return null;
  }
}

/** A saved run only keeps the result and inputs; evidence is recomputed on the next Generate. */
function runFromSaved(entry: SavedRun): PipelineRun {
  return {
    result: entry.result,
    evidence: {
      category: null,
      tables: [],
      mining: null,
      labels: [],
      aggregation: null,
      listing: null,
    },
    warnings: [],
    usage: {},
    calls: 0,
    prompts: [],
  };
}

const TIER_ORDER: Record<string, number> = { "Tier 1": 0, "Tier 2": 1, "Tier 3": 2 };

function safeRows(text: string): Row[] {
  try {
    return textToRows(text);
  } catch {
    return [];
  }
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

function download(name: string, type: string, body: string) {
  const blob = new Blob([body], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function toCsv(filters: FilterRow[]) {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = [
    "tier",
    "rank",
    "name",
    "ui_pattern",
    "values",
    "confidence",
    "rationale",
    "sources",
    "coverage_pct",
    "top_value_share_pct",
    "listing_fill_pct",
    "needs_new_isq",
    "isq_note",
  ];
  const rows = filters.map((f) =>
    [
      f.tier,
      f.rank,
      f.name,
      f.ui_pattern,
      f.values.join(" | "),
      f.confidence,
      f.rationale,
      (f.sources ?? []).join(" | "),
      f.coverage_pct,
      f.top_value_share_pct,
      f.listing_fill_pct,
      f.needs_new_isq,
      f.isq_note,
    ]
      .map(esc)
      .join(","),
  );
  return [head.join(","), ...rows].join("\n");
}

function Index() {
  const [settings, setSettings] = useState<LlmSettings>({
    provider: "openrouter",
    apiKey: "",
    baseUrl: DEFAULT_BASE_URLS.openrouter,
    model: MODEL_PRESETS[0]!.id,
  });
  const [remember, setRemember] = useState(false);
  const [testStatus, setTestStatus] = useState<Status>(null);

  const [serpText, setSerpText] = useState("");
  const [internalText, setInternalText] = useState("");
  const [contextText, setContextText] = useState("");
  const [specsText, setSpecsText] = useState("");
  const [productsText, setProductsText] = useState("");
  // Listings are a demo sample for now: keep low-fill filters and flag them.
  const [demoListings, setDemoListings] = useState(true);
  const [uiDesign, setUiDesign] = useState(true);

  const [serpFile, setSerpFile] = useState<Row[] | null>(null);
  const [internalFile, setInternalFile] = useState<Row[] | null>(null);
  const [productsFile, setProductsFile] = useState<Row[] | null>(null);

  const [serpStatus, setSerpStatus] = useState<Status>(null);
  const [internalStatus, setInternalStatus] = useState<Status>(null);
  const [productsStatus, setProductsStatus] = useState<Status>(null);

  const [showPrompt, setShowPrompt] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [steps, setSteps] = useState<StepView[]>([]);
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [tab, setTab] = useState<Tab>("table");
  const [device, setDevice] = useState<Device>("desktop");
  const [expandedFilter, setExpandedFilter] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedRun[]>([]);
  const [showSaved, setShowSaved] = useState(false);
  const [saveNote, setSaveNote] = useState("");
  const [savedLine, setSavedLine] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_KEY);
      if (raw) setSaved(JSON.parse(raw));
    } catch {
      /* storage unavailable or malformed */
    }
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setSettings((prev) => ({ ...prev, ...JSON.parse(saved) }));
        setRemember(true);
      }
    } catch {
      /* storage unavailable or malformed */
    }
  }, []);

  useEffect(() => {
    try {
      if (remember) localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
  }, [remember, settings]);

  const inputs: PipelineInputs = useMemo(
    () => ({
      serpRows: serpFile ?? safeRows(serpText),
      internalRows: internalFile ?? safeRows(internalText),
      context: contextText,
      specs: specsText,
      listingRows: productsFile ?? safeRows(productsText),
      demoListings,
      uiDesign,
    }),
    [
      serpFile,
      serpText,
      internalFile,
      internalText,
      contextText,
      specsText,
      productsFile,
      productsText,
      demoListings,
      uiDesign,
    ],
  );

  const serpDetail = useMemo(
    () => describeKeywordTable(toKeywordTable(inputs.serpRows, "serp")),
    [inputs.serpRows],
  );
  const internalDetail = useMemo(
    () => describeKeywordTable(toKeywordTable(inputs.internalRows, "internal")),
    [inputs.internalRows],
  );
  const productsDetail = useMemo(() => {
    if (!inputs.listingRows.length) return "";
    const flat = inputs.listingRows.slice(0, 500).map((r) => flattenListing(r));
    const specs = specSummary(flat, heuristicFieldMap(flat), 1000, 0);
    const groups = new Set(inputs.listingRows.map((r) => r["_group"]).filter(Boolean)).size;
    return [
      `${inputs.listingRows.length.toLocaleString()} listings`,
      groups > 1 ? `${groups} groups` : "",
      `${specs.length} spec fields detected (${specs.filter((s) => s.fillPct >= 30).length} filled on ≥30%)`,
    ]
      .filter(Boolean)
      .join(" · ");
  }, [inputs.listingRows]);

  const hasInput = Boolean(
    inputs.serpRows.length ||
    inputs.internalRows.length ||
    contextText.trim() ||
    specsText.trim() ||
    inputs.listingRows.length,
  );

  // Deferred so typing stays smooth while the preview/estimate recomputes.
  const deferredInputs = useDeferredValue(inputs);
  const previewRecords = useMemo(
    () => (hasInput ? previewPrompts(deferredInputs) : []),
    [deferredInputs, hasInput],
  );
  const promptRecords: PromptRecord[] = !showPrompt
    ? []
    : run?.prompts.length
      ? run.prompts
      : previewRecords;
  const estimate = useMemo(
    () =>
      previewRecords.length
        ? estimateRun(previewRecords)
        : { calls: 3, inputTokens: EST_RUN_TOKENS.input, outputTokens: EST_RUN_TOKENS.output },
    [previewRecords],
  );

  const preset = MODEL_PRESETS.find((m) => m.id === settings.model);
  const estINR = preset
    ? runCostInr(preset, estimate.inputTokens, estimate.outputTokens).toFixed(2)
    : null;
  const providerPresets = MODEL_PRESETS.filter((m) => m.provider === settings.provider);

  function setProvider(provider: Provider) {
    setSettings((prev) => ({
      ...prev,
      provider,
      baseUrl: DEFAULT_BASE_URLS[provider],
      // A model id from one provider is meaningless (and will 404 or auth-fail) against another
      // provider's endpoint, so switching providers falls back to that provider's first preset.
      model: MODEL_PRESETS.find((m) => m.provider === provider)?.id ?? prev.model,
    }));
    setTestStatus(null);
  }

  async function loadFile(
    file: File,
    setRows: (r: Row[] | null) => void,
    setStatus: (s: Status) => void,
  ) {
    setStatus({ kind: "busy", message: `Reading ${file.name}…` });
    try {
      const rows = await fileToRows(file);
      if (!rows.length) throw new Error("No rows found in this file.");
      setRows(rows);
      setStatus({
        kind: "ok",
        message: `Loaded ${rows.length.toLocaleString()} rows from ${file.name}`,
      });
    } catch (err) {
      setRows(null);
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  async function testConnection() {
    if (!settings.apiKey) {
      setTestStatus({ kind: "error", message: "Enter a key first." });
      return;
    }
    setTestStatus({ kind: "busy", message: "Testing…" });
    try {
      const { content } = await chat(
        settings,
        [
          { role: "system", content: "Reply with exactly: OK" },
          { role: "user", content: "ping" },
        ],
        { maxTokens: 10 },
      );
      setTestStatus({
        kind: "ok",
        message: `Connected — ${settings.model} replied "${content.trim().slice(0, 24)}"`,
      });
    } catch (err) {
      setTestStatus({ kind: "error", message: (err as Error).message });
    }
  }

  async function generate(from?: StepId) {
    setError("");
    if (!hasInput) {
      setError("Add at least one input above — any single one is enough.");
      return;
    }
    if (!settings.apiKey) {
      setError("Enter your API key first.");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setRun(null);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s })));
    try {
      const result = await runPipeline(settings, inputs, {
        signal: controller.signal,
        ...(from ? { from } : {}),
        onStep: (id, patch) =>
          setSteps((prev) =>
            prev.map((s) =>
              s.id === id
                ? {
                    ...s,
                    ...patch,
                    ...(patch.status === "running" ? { startedAt: Date.now() } : {}),
                  }
                : s,
            ),
          ),
      });
      setRun(result);
      setSavedLine("");
      setTab("table");
      setExpandedFilter(null);
    } catch (err) {
      setError((err as Error).name === "AbortError" ? "Stopped." : (err as Error).message);
      setSteps((prev) => prev.map((s) => (s.status === "running" ? { ...s, status: "error" } : s)));
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  /** Inputs in the saved-run format: rows as JSON strings, docs as text. */
  function currentBundle(): InputBundle {
    const rows = (r: Row[]) => (r.length ? JSON.stringify(r) : "");
    return {
      serp: rows(inputs.serpRows),
      internal: rows(inputs.internalRows),
      context: inputs.context,
      specs: inputs.specs,
      products: rows(inputs.listingRows),
    };
  }

  function persistSaved(next: SavedRun[]) {
    setSaved(next);
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(next));
    } catch {
      setSaveNote("Saved, but this device's storage is full — download the .md to keep it.");
    }
  }

  function downloadMarkdown(entry: SavedRun) {
    const md = buildMarkdown({
      name: entry.name,
      savedAt: entry.savedAt,
      model: entry.model,
      result: entry.result,
      inputs: entry.inputs ?? EMPTY_BUNDLE,
      device: entry.device ?? "desktop",
    });
    download(`${slugify(entry.name)}-${entry.savedAt.slice(0, 10)}.md`, "text/markdown", md);
  }

  function saveResult() {
    if (!run) return;
    const entry: SavedRun = {
      id: `${Date.now()}`,
      name: run.result.category_name || "Untitled category",
      savedAt: new Date().toISOString(),
      model: settings.model,
      result: run.result,
      inputs: currentBundle(),
      tab,
      device,
    };
    persistSaved([entry, ...saved]);
    setSaveNote(`Saved "${entry.name}"`);
    downloadMarkdown(entry);
    setTimeout(() => setSaveNote(""), 3500);
  }

  function openSaved(entry: SavedRun) {
    const i = entry.inputs ?? EMPTY_BUNDLE;
    const restored = (json: string): Status =>
      json ? { kind: "ok", message: "Restored from a saved run" } : null;
    setSerpFile(rowsFromBundle(i.serp));
    setSerpText("");
    setSerpStatus(restored(i.serp));
    setInternalFile(rowsFromBundle(i.internal));
    setInternalText("");
    setInternalStatus(restored(i.internal));
    setContextText(i.context);
    setSpecsText(i.specs);
    setProductsFile(rowsFromBundle(i.products));
    setProductsText("");
    setProductsStatus(restored(i.products));
    setRun(runFromSaved(entry));
    setSteps([]);
    setError("");
    setSavedLine(`Saved ${new Date(entry.savedAt).toLocaleString()} · ${entry.model}`);
    setDevice(entry.device ?? "desktop");
    setTab(entry.tab === "evidence" ? "table" : (entry.tab ?? "table"));
    setExpandedFilter(null);
    setShowSaved(false);
  }

  function deleteSaved(id: string) {
    persistSaved(saved.filter((s) => s.id !== id));
  }

  function clearAll() {
    setSerpText("");
    setInternalText("");
    setContextText("");
    setSpecsText("");
    setProductsText("");
    setSerpFile(null);
    setInternalFile(null);
    setProductsFile(null);
    setSerpStatus(null);
    setInternalStatus(null);
    setProductsStatus(null);
    setRun(null);
    setSteps([]);
    setError("");
    setShowPrompt(false);
  }

  const result = run?.result ?? null;
  const tierCount = (tier: string) => result?.filters.filter((f) => f.tier === tier).length ?? 0;

  const hasEvidence = Boolean(run && (run.evidence.tables.length || run.evidence.listing));
  // Runs made with "Include UI design" off have no options or UI patterns to show.
  const hasDesign = Boolean(
    result?.filters.some(
      (f) => f.values.length > 0 || (f.ui_pattern && f.ui_pattern !== "display only"),
    ),
  );

  // A one-line rollup so trust/gaps in a run are visible without reading every row.
  const filterSummary = useMemo(() => {
    if (!result?.filters.length) return null;
    const fs = result.filters;
    const byConfidence = { High: 0, Medium: 0, Low: 0 } as Record<string, number>;
    let needsIsq = 0;
    let noEvidence = 0;
    for (const f of fs) {
      byConfidence[f.confidence] = (byConfidence[f.confidence] ?? 0) + 1;
      if (f.needs_new_isq) needsIsq++;
      if (f.tier !== "Tier 3" && !f.linked_dimension && !f.linked_listing_spec) noEvidence++;
    }
    return { total: fs.length, byConfidence, needsIsq, noEvidence };
  }, [result]);

  const usageLine = useMemo(() => {
    if (!run) return "";
    if (savedLine) return savedLine;
    const { prompt_tokens: pin, completion_tokens: pout } = run.usage;
    let cost = "";
    if (preset?.tier === "FREE") {
      cost = " · free";
    } else if (preset && pin && pout) {
      const usd = (preset.inputCost * pin) / 1e6 + (preset.outputCost * pout) / 1e6;
      cost = ` · ~$${usd.toFixed(5)} (₹${(usd * USD_TO_INR).toFixed(2)})`;
    }
    return `${settings.model} · ${run.calls} call${run.calls === 1 ? "" : "s"} · in ${pin ?? "?"} tok · out ${pout ?? "?"} tok${cost}`;
  }, [run, preset, settings.model, savedLine]);

  const allPromptsText = promptRecords
    .map((p) =>
      [
        `##### ${p.title}`,
        ...p.messages.map((m) => `--- ${m.role.toUpperCase()} ---\n${m.content}`),
      ].join("\n\n"),
    )
    .join("\n\n\n");

  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <header className="mb-7">
        <div className="flex flex-wrap items-start gap-3">
          <div>
            <p className="label-caps mb-1">Category research → search UX</p>
            <h1 className="text-3xl font-bold">Search Filter Generator</h1>
          </div>
          <button
            type="button"
            onClick={() => setShowSaved((v) => !v)}
            className="ml-auto rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            {showSaved ? "Hide saved results" : `View saved results (${saved.length})`}
          </button>
        </div>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Add whatever data you have — keywords, research notes, spec rankings, listings. Every
          field is optional, and each one takes a dropped file or pasted text. The numbers are
          totalled in your browser; the model labels and judges them, and you get a ranked, tiered
          set of filters with the evidence behind each one.
        </p>
      </header>

      {showSaved ? (
        <section className="panel mb-5 p-4">
          <h2 className="font-display mb-2 text-sm font-semibold">Saved results</h2>
          {saved.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing saved yet. Generate filters, then use “Save results + download .md”.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {saved.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{s.name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      {new Date(s.savedAt).toLocaleString()} · {s.result.filters.length} filters ·{" "}
                      {s.model}
                    </div>
                  </div>
                  <div className="ml-auto flex gap-2">
                    <button
                      type="button"
                      onClick={() => openSaved(s)}
                      className="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-semibold hover:bg-accent"
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadMarkdown(s)}
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
                    >
                      Download .md
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteSaved(s.id)}
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-destructive hover:bg-danger-soft"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* Connection */}
      <section className="panel mb-5 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="font-display text-sm font-semibold">Your AI key</h2>
          <div className="ml-auto inline-flex rounded-lg border border-border bg-secondary p-0.5">
            {(["openrouter", "groq", "litellm"] as Provider[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProvider(p)}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                  settings.provider === p
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p === "openrouter" ? "OpenRouter" : p === "groq" ? "Groq" : "LiteLLM"}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label-caps mb-1 block" htmlFor="api-key">
              {settings.provider === "openrouter"
                ? "OpenRouter key"
                : settings.provider === "groq"
                  ? "Groq key"
                  : "LiteLLM key"}
            </label>
            <input
              id="api-key"
              type="password"
              className="field"
              placeholder={
                settings.provider === "openrouter"
                  ? "sk-or-v1-…"
                  : settings.provider === "groq"
                    ? "gsk_…"
                    : "sk-…"
              }
              value={settings.apiKey}
              onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
            />
          </div>
          <div>
            <label className="label-caps mb-1 block" htmlFor="base-url">
              Server address
            </label>
            <input
              id="base-url"
              type="text"
              className="field"
              value={settings.baseUrl}
              onChange={(e) => setSettings((s) => ({ ...s, baseUrl: e.target.value }))}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label-caps mb-1 block" htmlFor="model">
              Model
            </label>
            <input
              id="model"
              list="model-presets"
              className="field"
              value={settings.model}
              onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
            />
            <datalist id="model-presets">
              {providerPresets.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </datalist>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={testConnection}
            className="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground transition-colors hover:bg-accent"
          >
            Test connection
          </button>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Remember on this device
          </label>
          {testStatus ? (
            <span
              className={`text-xs ${
                testStatus.kind === "error"
                  ? "text-destructive"
                  : testStatus.kind === "ok"
                    ? "text-success"
                    : "text-muted-foreground"
              }`}
            >
              {testStatus.message}
            </span>
          ) : null}
        </div>

        {settings.provider === "litellm" ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Point this at your LiteLLM gateway address and use the model name exactly as it is
            configured there.
          </p>
        ) : null}
        {settings.provider === "groq" ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Free tier, no cost per token (rate-limited instead) — get a key at{" "}
            <span className="font-mono">console.groq.com/keys</span>. Good for testing prompt
            changes quickly without spending anything.
          </p>
        ) : null}
      </section>

      {/* Model price strip */}
      <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
        {providerPresets.map((m) => {
          const active = m.id === settings.model;
          const free = m.tier === "FREE";
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setSettings((s) => ({ ...s, model: m.id }))}
              className={`min-w-40 shrink-0 rounded-lg border p-3 text-left transition-colors ${
                active
                  ? "border-primary bg-primary-soft"
                  : "border-border bg-card hover:border-primary/50"
              }`}
            >
              <div className="flex items-center gap-1.5">
                {m.tier ? (
                  <span
                    className={`rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wider ${
                      m.tier === "DEFAULT"
                        ? "bg-success-soft text-success"
                        : m.tier === "BETTER"
                          ? "bg-warning-soft text-warning"
                          : m.tier === "FREE"
                            ? "bg-success-soft text-success"
                            : "bg-primary-soft text-primary"
                    }`}
                  >
                    {m.tier}
                  </span>
                ) : null}
                <span className="text-xs font-semibold">{m.name}</span>
              </div>
              {free ? (
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                  no per-token cost
                </div>
              ) : (
                <>
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                    ${m.inputCost} in · ${m.outputCost} out
                  </div>
                  <div className="font-mono text-[11px] font-semibold">
                    ~₹{runCostInr(m, estimate.inputTokens, estimate.outputTokens).toFixed(2)}/run
                  </div>
                </>
              )}
            </button>
          );
        })}
      </div>

      {/* Inputs */}
      <div className="grid gap-4 md:grid-cols-2">
        <InputPanel
          step={1}
          title="Google SERP keywords"
          hint="Search Console queries with clicks, impressions and position."
          accept=".xlsx,.csv,.tsv,.txt"
          placeholder={"query,clicks,impressions,position\nsecurity cabin price,120,5400,6.2\n…"}
          text={serpText}
          onTextChange={(v) => {
            setSerpText(v);
            setSerpFile(null);
            setSerpStatus(null);
          }}
          onFile={(f) => loadFile(f, setSerpFile, setSerpStatus)}
          status={serpStatus}
          detail={serpDetail}
        />
        <InputPanel
          step={2}
          title="Internal search keywords"
          hint="Search-bar queries with pageviews, CTR, conversion and enquiry metrics."
          accept=".xlsx,.csv,.tsv,.txt"
          placeholder={"keyword,pageviews,enquiries\npuf security cabin,400,90\n…"}
          text={internalText}
          onTextChange={(v) => {
            setInternalText(v);
            setInternalFile(null);
            setInternalStatus(null);
          }}
          onFile={(f) => loadFile(f, setInternalFile, setInternalStatus)}
          status={internalStatus}
          detail={internalDetail}
        />
        <InputPanel
          step={3}
          title="Category context document"
          hint="Buyer interview notes, display attributes, spec audits."
          accept=".txt,.md,.csv"
          placeholder="Paste the category context document here…"
          text={contextText}
          onTextChange={setContextText}
          onFile={async (f) => setContextText(await f.text())}
          tall
        />
        <InputPanel
          step={4}
          title="Spec importance ranking"
          hint="The category manager's ranked spec list or tiers."
          accept=".txt,.md,.csv"
          placeholder={
            "Green (top): 1-Size, 2-Material, 3-Application\nYellow (mid): 4-Built Type, 5-Insulation\nPurple (low): 6-Brand, 7-Roof Type"
          }
          text={specsText}
          onTextChange={setSpecsText}
          onFile={async (f) => setSpecsText(await f.text())}
          tall
        />
        <InputPanel
          step={5}
          title="Product listings"
          hint="Any export shape (JSON, CSV, XLSX). Nested specs are flattened, field names are mapped to clean specs, and fill rates are measured across all listings."
          accept=".json,.csv,.xlsx"
          placeholder="Paste listings JSON or CSV here…"
          text={productsText}
          onTextChange={(v) => {
            setProductsText(v);
            setProductsFile(null);
            setProductsStatus(null);
          }}
          onFile={(f) => loadFile(f, setProductsFile, setProductsStatus)}
          status={productsStatus}
          detail={productsDetail}
          className="md:col-span-2"
        />
      </div>

      <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={demoListings}
          onChange={(e) => setDemoListings(e.target.checked)}
        />
        <span>
          <strong className="text-foreground">Listings are a demo sample</strong> — keep filters
          with low listing fill rates in their tier and flag the fill rate in the rationale, instead
          of demoting them.
        </span>
      </label>

      <label className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={uiDesign}
          onChange={(e) => setUiDesign(e.target.checked)}
        />
        <span>
          <strong className="text-foreground">Include UI design</strong> — UI pattern, filter
          options and interaction rules for each filter. Untick to get only the filter list, tiers,
          confidence and rationale (shorter answer, cheaper run).
        </span>
      </label>

      {/* Actions */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {loading ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className="rounded-lg bg-destructive px-5 py-2.5 text-sm font-semibold text-destructive-foreground transition-opacity hover:opacity-90"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void generate()}
            className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Generate filter recommendations
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowPrompt((v) => !v)}
          className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
        >
          {showPrompt ? "Hide prompts" : "View prompts"}
        </button>
        <button
          type="button"
          onClick={() =>
            result &&
            download(
              "filter-recommendations.json",
              "application/json",
              JSON.stringify(result, null, 2),
            )
          }
          disabled={!result}
          className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-40"
        >
          Export JSON
        </button>
        <button
          type="button"
          onClick={() =>
            result && download("filter-recommendations.csv", "text/csv", toCsv(result.filters))
          }
          disabled={!result}
          className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-40"
        >
          Export CSV
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
        >
          Clear all
        </button>
        {preset ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            {preset.tier === "FREE" ? "free" : `~₹${estINR}/run`} · {estimate.calls} model call
            {estimate.calls === 1 ? "" : "s"} · ~{(estimate.inputTokens / 1000).toFixed(1)}k in /{" "}
            {(estimate.outputTokens / 1000).toFixed(1)}k out tokens
          </span>
        ) : null}
      </div>

      {showPrompt ? (
        <section className="panel mt-4 p-4">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h2 className="label-caps">
              {run ? "Prompts sent in the last run" : "Prompts (preview from your current inputs)"}
            </h2>
            <button
              type="button"
              onClick={() => copy(allPromptsText)}
              className="ml-auto rounded border border-border px-2 py-1 text-[11px] font-medium hover:bg-accent"
            >
              Copy all prompts
            </button>
            <button
              type="button"
              onClick={() => setShowSkills((v) => !v)}
              className="rounded border border-border px-2 py-1 text-[11px] font-medium hover:bg-accent"
            >
              {showSkills ? "Hide skill docs" : "Skill docs"}
            </button>
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
            Each system prompt is assembled from{" "}
            <code className="font-mono">src/skills/base.md</code> plus the “## Prompt” section of
            the skill docs listed under it. Edit one skill file to change one layer.
          </p>

          {showSkills ? (
            <div className="mb-4 grid gap-2">
              {Object.values(SKILLS).map((s) => (
                <details key={s.id} className="rounded-md border border-border bg-card">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
                    {s.title}{" "}
                    <span className="font-mono font-normal text-muted-foreground">
                      · src/skills/{s.file}
                    </span>
                  </summary>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border p-3 font-mono text-[11px] leading-relaxed">
                    {s.markdown}
                  </pre>
                </details>
              ))}
            </div>
          ) : null}

          <div className="grid gap-4">
            {promptRecords.map((p, pi) => (
              <div key={`${p.id}-${pi}`} className="rounded-lg border border-border p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <h3 className="font-display text-sm font-semibold">{p.title}</h3>
                  {p.stage ? (
                    <div className="flex flex-wrap gap-1">
                      {stageSkills(
                        p.stage,
                        p.stage === "design" && !uiDesign ? ["options"] : [],
                      ).map((s) => (
                        <span
                          key={s.id}
                          className="rounded bg-primary-soft px-1.5 py-px font-mono text-[10px] text-primary"
                          title={s.title}
                        >
                          {s.file}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                {p.messages.map((m, mi) => (
                  <div key={mi} className="mt-2">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="label-caps">
                        {m.role === "system"
                          ? "System prompt"
                          : m.role === "user"
                            ? "Data sent"
                            : "Model reply"}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        ~{Math.round(m.content.length / 4).toLocaleString()} tok
                      </span>
                      <button
                        type="button"
                        onClick={() => copy(m.content)}
                        className="ml-auto rounded border border-border px-2 py-0.5 text-[10px] font-medium hover:bg-accent"
                      >
                        Copy
                      </button>
                    </div>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-secondary p-3 font-mono text-[11px] leading-relaxed">
                      {m.content}
                    </pre>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-lg bg-danger-soft px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {steps.length ? (
        <StepCards
          steps={steps}
          preset={preset}
          busy={loading}
          onRerun={(from) => void generate(from)}
        />
      ) : null}

      {run && result ? (
        <section className="mt-6">
          <div className="mb-4 flex flex-wrap gap-3">
            {[
              { label: "Total filters", value: result.filters.length, tone: "" },
              { label: "Tier 1", value: tierCount("Tier 1"), tone: "text-success" },
              { label: "Tier 2", value: tierCount("Tier 2"), tone: "text-warning" },
              { label: "Tier 3 (display)", value: tierCount("Tier 3"), tone: "text-destructive" },
              ...(result.total_keywords_analyzed
                ? [{ label: "Keywords analysed", value: result.total_keywords_analyzed, tone: "" }]
                : []),
              ...(run.evidence.listing
                ? [{ label: "Listings profiled", value: run.evidence.listing.count, tone: "" }]
                : []),
            ].map((s) => (
              <div key={s.label} className="panel min-w-32 flex-1 px-4 py-3">
                <div className={`font-display text-2xl font-bold ${s.tone}`}>
                  {s.value.toLocaleString()}
                </div>
                <div className="text-[11px] text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>

          {result.category_name ? (
            <p className="mb-3 text-sm">
              Category: <strong>{result.category_name}</strong>
            </p>
          ) : null}

          {run.warnings.length ? (
            <div className="mb-4 rounded-lg bg-warning-soft px-4 py-3 text-xs text-warning-foreground">
              <strong className="mb-1 block">Check these before using the output</strong>
              <ul className="list-disc pl-4 leading-relaxed">
                {run.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {filterSummary ? (
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-border bg-card px-4 py-2.5 text-xs">
              <span className="text-muted-foreground">
                <strong className="text-foreground">{filterSummary.total}</strong> filters
              </span>
              <span className="h-3 w-px bg-border" />
              {(["High", "Medium", "Low"] as const).map((c) =>
                filterSummary.byConfidence[c] ? (
                  <span key={c} className="flex items-center gap-1">
                    <span
                      className={`size-1.5 rounded-full ${
                        c === "High" ? "bg-success" : c === "Medium" ? "bg-warning" : "bg-destructive"
                      }`}
                    />
                    <strong>{filterSummary.byConfidence[c]}</strong>
                    <span className="text-muted-foreground">{c.toLowerCase()} confidence</span>
                  </span>
                ) : null,
              )}
              {filterSummary.needsIsq ? (
                <>
                  <span className="h-3 w-px bg-border" />
                  <span className="text-destructive">
                    <strong>{filterSummary.needsIsq}</strong> need{" "}
                    {filterSummary.needsIsq === 1 ? "s" : ""} a new ISQ
                  </span>
                </>
              ) : null}
              {filterSummary.noEvidence ? (
                <>
                  <span className="h-3 w-px bg-border" />
                  <span className="text-muted-foreground">
                    <strong className="text-foreground">{filterSummary.noEvidence}</strong> with no
                    linked evidence
                  </span>
                </>
              ) : null}
            </div>
          ) : null}

          <div className="mb-3 flex flex-wrap items-center gap-1 border-b-2 border-border">
            {(["table", "preview", "evidence", "raw"] as const)
              .filter((t) => t !== "evidence" || hasEvidence)
              .filter((t) => t !== "preview" || hasDesign)
              .map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`-mb-0.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                    tab === t
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t === "table"
                    ? "Filter table"
                    : t === "preview"
                      ? "See it on a page"
                      : t === "evidence"
                        ? "Evidence"
                        : "Raw JSON"}
                </button>
              ))}
            <div className="mb-2 ml-auto flex items-center gap-2">
              {saveNote ? <span className="text-xs text-success">{saveNote}</span> : null}
              <button
                type="button"
                onClick={saveResult}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
              >
                Save results + download .md
              </button>
            </div>
          </div>

          {tab === "table" ? (
            <div className="panel overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {[
                      "#",
                      "Tier",
                      "Filter",
                      ...(hasDesign ? ["UI pattern", "Values"] : []),
                      "Confidence",
                      "Why",
                    ].map((h) => (
                      <th
                        key={h}
                        className="label-caps border-b-2 border-border px-3 py-2.5 text-left whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...result.filters]
                    .sort(
                      (a, b) =>
                        (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) || a.rank - b.rank,
                    )
                    .flatMap((f, i) => {
                      const key = `${f.name}-${i}`;
                      const open = expandedFilter === key;
                      const row = (
                        <tr
                          key={key}
                          onClick={() => setExpandedFilter(open ? null : key)}
                          className={`cursor-pointer border-b border-border align-top transition-colors last:border-0 hover:bg-accent/50 ${
                            open ? "border-b-0 bg-accent/40" : ""
                          }`}
                          title={open ? "Click to collapse" : "Click to see the full reasoning"}
                        >
                          <td className="px-3 py-3 font-semibold">{i + 1}</td>
                        <td className="px-3 py-3">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider whitespace-nowrap ${
                              f.tier === "Tier 1"
                                ? "bg-success-soft text-success"
                                : f.tier === "Tier 2"
                                  ? "bg-warning-soft text-warning"
                                  : "bg-danger-soft text-destructive"
                            }`}
                          >
                            {f.tier}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <strong>{f.name}</strong>
                          <div className="mt-1 flex flex-wrap gap-x-2 font-mono text-[10px] text-muted-foreground">
                            {f.coverage_pct != null ? (
                              <span>coverage {f.coverage_pct}%</span>
                            ) : null}
                            {f.top_value_share_pct != null ? (
                              <span>top value {f.top_value_share_pct}%</span>
                            ) : null}
                            {f.listing_fill_pct != null ? (
                              <span>filled {f.listing_fill_pct}%</span>
                            ) : null}
                          </div>
                          {f.needs_new_isq ? (
                            <div className="mt-1 text-[10px] text-destructive">
                              ⚠ {f.isq_note || "Needs a new listing field"}
                            </div>
                          ) : null}
                        </td>
                        {hasDesign ? (
                          <>
                            <td className="px-3 py-3 text-xs">{f.ui_pattern}</td>
                            <td className="px-3 py-3">
                              <div className="flex flex-wrap gap-1">
                                {f.values.slice(0, 15).map((v, vi) => (
                                  <span
                                    key={`${v}-${vi}`}
                                    className="rounded border border-border bg-secondary px-1.5 py-px text-[11px]"
                                  >
                                    {v}
                                  </span>
                                ))}
                                {f.values.length > 15 ? (
                                  <span className="rounded border border-border px-1.5 py-px text-[11px] text-muted-foreground">
                                    +{f.values.length - 15}
                                  </span>
                                ) : null}
                              </div>
                            </td>
                          </>
                        ) : null}
                        <td className="px-3 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                              f.confidence === "High"
                                ? "bg-success-soft text-success"
                                : f.confidence === "Medium"
                                  ? "bg-warning-soft text-warning"
                                  : "bg-danger-soft text-destructive"
                            }`}
                          >
                            {f.confidence}
                          </span>
                        </td>
                          <td className="max-w-72 px-3 py-3 text-xs text-muted-foreground">
                            <div className="flex items-start gap-1.5">
                              <span
                                className={`mt-0.5 shrink-0 text-[9px] text-muted-foreground/70 transition-transform ${open ? "rotate-90" : ""}`}
                              >
                                ▶
                              </span>
                              <span>{f.rationale}</span>
                            </div>
                            {f.sources?.length ? (
                              <div className="mt-1 ml-3.5 flex flex-wrap gap-1">
                                {f.sources.map((s) => (
                                  <span
                                    key={s}
                                    className="rounded bg-secondary px-1 py-px font-mono text-[9px] uppercase"
                                  >
                                    {s}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                      return open
                        ? [
                            row,
                            <FilterDetailRow
                              key={`${key}-detail`}
                              filter={f}
                              evidence={run.evidence}
                              colSpan={hasDesign ? 7 : 5}
                            />,
                          ]
                        : [row];
                    })}
                </tbody>
              </table>

              {result.interaction_rules?.length || result.blockers?.length ? (
                <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-2">
                  {result.interaction_rules?.length ? (
                    <div>
                      <h3 className="label-caps mb-1">Interaction rules</h3>
                      <ul className="list-disc pl-4 text-xs leading-relaxed">
                        {result.interaction_rules.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {result.blockers?.length ? (
                    <div>
                      <h3 className="label-caps mb-1 text-destructive">Blockers</h3>
                      <ul className="list-disc pl-4 text-xs leading-relaxed text-destructive">
                        {result.blockers.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : tab === "preview" && hasDesign ? (
            <SearchPreview result={result} initialDevice={device} onDeviceChange={setDevice} />
          ) : tab === "evidence" && hasEvidence ? (
            <EvidenceView run={run} />
          ) : (
            <pre className="panel max-h-[28rem] overflow-auto p-4 font-mono text-[11px] whitespace-pre-wrap">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}

          {usageLine ? (
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">{usageLine}</p>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

function EvidenceView({ run }: { run: PipelineRun }) {
  const { tables, aggregation, listing, mining, labels } = run.evidence;
  const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
  return (
    <div className="grid gap-4">
      <p className="text-xs text-muted-foreground">
        These tables were computed in your browser and are exactly what the master prompt received.
        The model only labelled the keyword terms ({labels.length} of {mining?.terms.length ?? 0})
        and mapped listing fields.
      </p>

      {tables.length ? (
        <div className="panel p-4">
          <h3 className="label-caps mb-2">Keyword sources</h3>
          <ul className="grid gap-1 font-mono text-[11px]">
            {tables.map((t) => (
              <li key={t.source}>
                <strong>{SOURCE_LABEL[t.source]}</strong> — {describeKeywordTable(t)} · total{" "}
                {fmt(t.totalDemand)} {t.demandMetric ?? "keywords"}
                {aggregation
                  ? ` · ${aggregation.genericShare[t.source] ?? 0}% generic (no qualifier)`
                  : ""}
              </li>
            ))}
          </ul>
          {mining?.coreTerms.length ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Core category words: {mining.coreTerms.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {aggregation?.dimensions.map((d) => (
        <div key={d.name} className="panel overflow-x-auto p-4">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h3 className="font-display text-sm font-semibold">{d.name}</h3>
            {tables.map((t) =>
              d.bySource[t.source] ? (
                <span key={t.source} className="font-mono text-[11px] text-muted-foreground">
                  {SOURCE_LABEL[t.source]}: coverage {d.bySource[t.source]!.coverage}% · top value{" "}
                  {d.bySource[t.source]!.topShare}%
                </span>
              ) : null,
            )}
          </div>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="label-caps border-b border-border px-2 py-1.5 text-left">Value</th>
                {tables.map((t) => (
                  <th
                    key={t.source}
                    className="label-caps border-b border-border px-2 py-1.5 text-right"
                    colSpan={t.actionMetric ? 3 : 2}
                  >
                    {SOURCE_LABEL[t.source]}
                  </th>
                ))}
              </tr>
              <tr className="text-[10px] text-muted-foreground">
                <th />
                {tables.map((t) => [
                  <th key={`${t.source}-d`} className="px-2 py-1 text-right font-normal">
                    {t.demandMetric ?? "kws"}
                  </th>,
                  <th key={`${t.source}-s`} className="px-2 py-1 text-right font-normal">
                    share
                  </th>,
                  t.actionMetric ? (
                    <th key={`${t.source}-a`} className="px-2 py-1 text-right font-normal">
                      {t.actionMetric}
                    </th>
                  ) : null,
                ])}
              </tr>
            </thead>
            <tbody>
              {d.values.slice(0, 20).map((v) => (
                <tr key={v.value} className="border-b border-border last:border-0">
                  <td className="px-2 py-1.5">{v.value}</td>
                  {tables.map((t) => {
                    const b = v.bySource[t.source];
                    return [
                      <td key={`${t.source}-d`} className="px-2 py-1.5 text-right font-mono">
                        {b ? fmt(b.demand) : "–"}
                      </td>,
                      <td key={`${t.source}-s`} className="px-2 py-1.5 text-right font-mono">
                        {b ? `${b.share}%` : "–"}
                      </td>,
                      t.actionMetric ? (
                        <td key={`${t.source}-a`} className="px-2 py-1.5 text-right font-mono">
                          {b ? fmt(b.action) : "–"}
                        </td>
                      ) : null,
                    ];
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {listing ? (
        <div className="panel overflow-x-auto p-4">
          <h3 className="label-caps mb-2">
            Listing spec profile · {listing.count} listings
            {listing.mapped ? "" : " (raw field names)"}
          </h3>
          {listing.price ? (
            <p className="mb-2 font-mono text-[11px] text-muted-foreground">
              Price ({listing.price.n} priced
              {listing.price.unit ? `, per ${listing.price.unit}` : ""}): min ₹
              {fmt(listing.price.min)} · p25 ₹{fmt(listing.price.p25)} · median ₹
              {fmt(listing.price.median)} · p75 ₹{fmt(listing.price.p75)} · max ₹
              {fmt(listing.price.max)}
            </p>
          ) : null}
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {["Spec", "Filled", "Distinct", "Most common values"].map((h) => (
                  <th key={h} className="label-caps border-b border-border px-2 py-1.5 text-left">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {listing.fields.map((f) => (
                <tr key={f.key} className="border-b border-border align-top last:border-0">
                  <td className="px-2 py-1.5" title={f.sources.join(", ")}>
                    {f.key}
                  </td>
                  <td
                    className={`px-2 py-1.5 font-mono ${f.fillPct >= 60 ? "text-success" : f.fillPct >= 30 ? "text-warning" : "text-destructive"}`}
                  >
                    {f.fillPct}%
                  </td>
                  <td className="px-2 py-1.5 font-mono">{f.distinct}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {f.top.map(([v, n]) => `${v} (${n})`).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
