import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { InputPanel } from "@/components/InputPanel";
import { SearchPreview } from "@/components/SearchPreview";
import {
  DEFAULT_BASE_URLS,
  MODEL_PRESETS,
  PRODUCT_RESTRUCTURE_SYSTEM,
  buildPrompts,
  callLlm,
  fileToRows,
  stripFences,
  type FilterResult,
  type LlmSettings,
  type Provider,
} from "@/lib/filter-gen";

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

  const [serpFile, setSerpFile] = useState("");
  const [internalFile, setInternalFile] = useState("");
  const [productsFile, setProductsFile] = useState("");

  const [serpStatus, setSerpStatus] = useState<Status>(null);
  const [internalStatus, setInternalStatus] = useState<Status>(null);
  const [productsStatus, setProductsStatus] = useState<Status>(null);

  const [showPrompt, setShowPrompt] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<FilterResult | null>(null);
  const [usageLine, setUsageLine] = useState("");
  const [tab, setTab] = useState<"table" | "preview" | "raw">("table");

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        setSettings((prev) => ({ ...prev, ...JSON.parse(saved) }));
        setRemember(true);
      } catch {
        /* ignore malformed storage */
      }
    }
  }, []);

  useEffect(() => {
    if (remember) localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    else localStorage.removeItem(STORAGE_KEY);
  }, [remember, settings]);

  const inputs = useMemo(
    () => ({
      serp: serpFile || serpText,
      internal: internalFile || internalText,
      context: contextText,
      specs: specsText,
      products: productsFile || productsText,
    }),
    [serpFile, serpText, internalFile, internalText, contextText, specsText, productsFile, productsText],
  );

  const prompts = useMemo(() => buildPrompts(inputs), [inputs]);
  const preset = MODEL_PRESETS.find((m) => m.id === settings.model);
  const estINR = preset
    ? (((preset.inputCost * 4000) / 1e6 + (preset.outputCost * 2000) / 1e6) * 84).toFixed(2)
    : null;

  function setProvider(provider: Provider) {
    setSettings((prev) => ({ ...prev, provider, baseUrl: DEFAULT_BASE_URLS[provider] }));
    setTestStatus(null);
  }

  async function loadSheet(
    file: File,
    setFileData: (v: string) => void,
    setStatus: (s: Status) => void,
  ) {
    setStatus({ kind: "busy", message: `Reading ${file.name}…` });
    try {
      const rows = await fileToRows(file, 200);
      setFileData(JSON.stringify(rows));
      setStatus({ kind: "ok", message: `Loaded ${rows.length} rows from ${file.name}` });
    } catch (err) {
      setFileData("");
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  async function loadProducts(file: File) {
    setProductsStatus({ kind: "busy", message: `Reading ${file.name}…` });
    try {
      const rows = await fileToRows(file, 100);
      if (!settings.apiKey) {
        setProductsFile(JSON.stringify(rows));
        setProductsStatus({
          kind: "ok",
          message: `Loaded ${rows.length} listings as-is — add a key above and re-drop to tidy them up`,
        });
        return;
      }
      setProductsStatus({ kind: "busy", message: `Tidying up ${rows.length} listings…` });
      const { content } = await callLlm(
        settings,
        PRODUCT_RESTRUCTURE_SYSTEM,
        `Raw product data (${rows.length} items) from file "${file.name}":\n\n${JSON.stringify(rows).substring(0, 20000)}`,
        4000,
      );
      const parsed = JSON.parse(stripFences(content));
      if (!Array.isArray(parsed?.products)) throw new Error("The model did not return a usable list of products.");
      setProductsFile(JSON.stringify(parsed.products));
      setProductsStatus({ kind: "ok", message: `Cleaned up ${parsed.products.length} listings from ${file.name}` });
    } catch (err) {
      setProductsFile("");
      setProductsStatus({ kind: "error", message: (err as Error).message });
    }
  }

  async function testConnection() {
    if (!settings.apiKey) {
      setTestStatus({ kind: "error", message: "Enter a key first." });
      return;
    }
    setTestStatus({ kind: "busy", message: "Testing…" });
    try {
      const { content } = await callLlm(settings, "Reply with exactly: OK", "ping", 10);
      setTestStatus({ kind: "ok", message: `Connected — ${settings.model} replied "${content.trim().slice(0, 24)}"` });
    } catch (err) {
      setTestStatus({ kind: "error", message: (err as Error).message });
    }
  }

  async function generate() {
    setError("");
    if (!prompts.hasInput) {
      setError("Add at least one input above — any single one is enough.");
      return;
    }
    if (!settings.apiKey) {
      setError("Enter your API key first.");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const { content, usage } = await callLlm(settings, prompts.system, prompts.user, 4000);
      const parsed = JSON.parse(stripFences(content)) as FilterResult;
      if (!Array.isArray(parsed.filters)) throw new Error('The response had no "filters" list.');
      setResult(parsed);
      setTab("table");
      let cost = "";
      if (preset && usage.prompt_tokens && usage.completion_tokens) {
        const usd =
          (preset.inputCost * usage.prompt_tokens) / 1e6 + (preset.outputCost * usage.completion_tokens) / 1e6;
        cost = ` · ~$${usd.toFixed(5)} (₹${(usd * 84).toFixed(2)})`;
      }
      setUsageLine(
        `${settings.model} · in ${usage.prompt_tokens ?? "?"} tok · out ${usage.completion_tokens ?? "?"} tok${cost}`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function clearAll() {
    setSerpText("");
    setInternalText("");
    setContextText("");
    setSpecsText("");
    setProductsText("");
    setSerpFile("");
    setInternalFile("");
    setProductsFile("");
    setSerpStatus(null);
    setInternalStatus(null);
    setProductsStatus(null);
    setResult(null);
    setError("");
    setUsageLine("");
    setShowPrompt(false);
  }

  function exportJson() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "filter-recommendations.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const tierCount = (tier: string) => result?.filters.filter((f) => f.tier === tier).length ?? 0;

  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <header className="mb-7">
        <p className="label-caps mb-1">Category research → search UX</p>
        <h1 className="text-3xl font-bold">Search Filter Generator</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Add whatever data you have — keywords, research notes, spec rankings, listings. Every field is optional,
          and each one takes a dropped file or pasted text. You get back a ranked, tiered set of filters with the
          evidence behind each one.
        </p>
      </header>

      {/* Connection */}
      <section className="panel mb-5 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="font-display text-sm font-semibold">Your AI key</h2>
          <div className="ml-auto inline-flex rounded-lg border border-border bg-secondary p-0.5">
            {(["openrouter", "litellm"] as Provider[]).map((p) => (
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
                {p === "openrouter" ? "OpenRouter" : "LiteLLM"}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label-caps mb-1 block" htmlFor="api-key">
              {settings.provider === "openrouter" ? "OpenRouter key" : "LiteLLM key"}
            </label>
            <input
              id="api-key"
              type="password"
              className="field"
              placeholder={settings.provider === "openrouter" ? "sk-or-v1-…" : "sk-…"}
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
              {MODEL_PRESETS.map((m) => (
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
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
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
            Point this at your LiteLLM gateway address and use the model name exactly as it is configured there.
          </p>
        ) : null}
      </section>

      {/* Model price strip */}
      <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
        {MODEL_PRESETS.map((m) => {
          const runINR = (((m.inputCost * 4000) / 1e6 + (m.outputCost * 2000) / 1e6) * 84).toFixed(2);
          const active = m.id === settings.model;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setSettings((s) => ({ ...s, model: m.id }))}
              className={`min-w-40 shrink-0 rounded-lg border p-3 text-left transition-colors ${
                active ? "border-primary bg-primary-soft" : "border-border bg-card hover:border-primary/50"
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
                          : "bg-primary-soft text-primary"
                    }`}
                  >
                    {m.tier}
                  </span>
                ) : null}
                <span className="text-xs font-semibold">{m.name}</span>
              </div>
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                ${m.inputCost} in · ${m.outputCost} out
              </div>
              <div className="font-mono text-[11px] font-semibold">~₹{runINR}/run</div>
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
          accept=".xlsx,.csv"
          placeholder="Paste CSV rows here…"
          text={serpText}
          onTextChange={setSerpText}
          onFile={(f) => loadSheet(f, setSerpFile, setSerpStatus)}
          status={serpStatus}
        />
        <InputPanel
          step={2}
          title="Internal search keywords"
          hint="Search-bar queries with CTR, engagement, conversion and enquiry metrics."
          accept=".xlsx,.csv"
          placeholder="Paste CSV rows here…"
          text={internalText}
          onTextChange={setInternalText}
          onFile={(f) => loadSheet(f, setInternalFile, setInternalStatus)}
          status={internalStatus}
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
          placeholder={"Green (top): 1-Size, 2-Material, 3-Application\nYellow (mid): 4-Built Type, 5-Insulation\nPurple (low): 6-Brand, 7-Roof Type"}
          text={specsText}
          onTextChange={setSpecsText}
          onFile={async (f) => setSpecsText(await f.text())}
          tall
        />
        <InputPanel
          step={5}
          title="Product listings (top 100)"
          hint="Any export shape — with a key set, it gets tidied into a clean structure first. Pasted text is used as-is."
          accept=".json,.csv,.xlsx"
          placeholder="Paste listings JSON here…"
          text={productsText}
          onTextChange={setProductsText}
          onFile={loadProducts}
          status={productsStatus}
          className="md:col-span-2"
        />
      </div>

      {/* Actions */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={generate}
          disabled={loading}
          className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {loading ? "Generating…" : "Generate filter recommendations"}
        </button>
        <button
          type="button"
          onClick={() => setShowPrompt((v) => !v)}
          className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
        >
          {showPrompt ? "Hide instructions" : "View instructions"}
        </button>
        <button
          type="button"
          onClick={exportJson}
          disabled={!result}
          className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-40"
        >
          Export JSON
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
        >
          Clear all
        </button>
        <span className="font-mono text-[11px] text-muted-foreground">
          ~{Math.round((prompts.system.length + prompts.user.length) / 4).toLocaleString()} tokens
          {estINR ? ` · ~₹${estINR}/run` : ""}
        </span>
      </div>

      {showPrompt ? (
        <section className="panel mt-4 p-4">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="label-caps">What the model is told</h2>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(prompts.system)}
              className="ml-auto rounded border border-border px-2 py-1 text-[11px] font-medium hover:bg-accent"
            >
              Copy instructions
            </button>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(prompts.user)}
              className="rounded border border-border px-2 py-1 text-[11px] font-medium hover:bg-accent"
            >
              Copy your data
            </button>
          </div>
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-md bg-secondary p-3 font-mono text-[11px] leading-relaxed">
            {prompts.system}
          </pre>
          <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-md bg-secondary p-3 font-mono text-[11px] leading-relaxed">
            {prompts.user}
          </pre>
        </section>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-lg bg-danger-soft px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}

      {loading ? (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-4 text-sm text-muted-foreground">
          <span className="size-4 animate-spin rounded-full border-2 border-border border-t-primary" />
          Working through your data with {settings.model}…
        </div>
      ) : null}

      {result ? (
        <section className="mt-6">
          <div className="mb-4 flex flex-wrap gap-3">
            {[
              { label: "Total filters", value: result.filters.length, tone: "" },
              { label: "Tier 1", value: tierCount("Tier 1"), tone: "text-success" },
              { label: "Tier 2", value: tierCount("Tier 2"), tone: "text-warning" },
              { label: "Tier 3", value: tierCount("Tier 3"), tone: "text-destructive" },
              ...(result.total_keywords_analyzed
                ? [{ label: "Keywords analysed", value: result.total_keywords_analyzed, tone: "" }]
                : []),
            ].map((s) => (
              <div key={s.label} className="panel min-w-32 flex-1 px-4 py-3">
                <div className={`font-display text-2xl font-bold ${s.tone}`}>{s.value.toLocaleString()}</div>
                <div className="text-[11px] text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>

          <div className="mb-3 flex gap-1 border-b-2 border-border">
            {(["table", "preview", "raw"] as const).map((t) => (
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
                {t === "table" ? "Filter table" : t === "preview" ? "See it on a page" : "Raw JSON"}
              </button>
            ))}
          </div>


          {tab === "table" ? (
            <div className="panel overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {["#", "Tier", "Filter", "UI pattern", "Values", "Confidence", "Why"].map((h) => (
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
                    .sort((a, b) => {
                      const order: Record<string, number> = { "Tier 1": 0, "Tier 2": 1, "Tier 3": 2 };
                      return (order[a.tier] ?? 9) - (order[b.tier] ?? 9) || a.rank - b.rank;
                    })
                    .map((f, i) => (
                      <tr key={`${f.name}-${i}`} className="border-b border-border last:border-0 align-top">
                        <td className="px-3 py-3 font-semibold">{i + 1}</td>
                        <td className="px-3 py-3">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
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
                          {f.needs_new_isq ? (
                            <div className="mt-1 text-[10px] text-destructive">
                              ⚠ {f.isq_note || "Needs a new listing field"}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 text-xs">{f.ui_pattern}</td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1">
                            {(f.values ?? []).slice(0, 15).map((v, vi) => (
                              <span
                                key={`${v}-${vi}`}
                                className="rounded border border-border bg-secondary px-1.5 py-px text-[11px]"
                              >
                                {v}
                              </span>
                            ))}
                            {(f.values ?? []).length > 15 ? (
                              <span className="rounded border border-border px-1.5 py-px text-[11px] text-muted-foreground">
                                +{(f.values ?? []).length - 15}
                              </span>
                            ) : null}
                          </div>
                        </td>
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
                        <td className="max-w-64 px-3 py-3 text-xs text-muted-foreground">{f.rationale}</td>
                      </tr>
                    ))}
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
          ) : tab === "preview" ? (
            <SearchPreview result={result} />
          ) : (
            <pre className="panel max-h-[28rem] overflow-auto p-4 font-mono text-[11px] whitespace-pre-wrap">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}


          {usageLine ? <p className="mt-2 font-mono text-[11px] text-muted-foreground">{usageLine}</p> : null}
        </section>
      ) : null}
    </main>
  );
}
