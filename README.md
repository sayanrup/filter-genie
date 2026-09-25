# Filter Genie — Search Filter Generator

Turns category research into a ranked, tiered set of **search-page filters** for a B2B marketplace
(IndiaMART-style): which filters to show, in what order, with which options — and which specs belong on
the listing card instead.

Every input is optional; drop a file or paste text into any of them:

| # | Input | Typical source |
|---|-------|----------------|
| 1 | Google SERP keywords | Search Console export — query, clicks, impressions, position |
| 2 | Internal search keywords | Site-search report — keyword, pageviews, enquiries, calls, CTR/conversion |
| 3 | Category context document | Buyer/seller interview notes, display-attribute research, spec audits |
| 4 | Spec importance ranking | The category manager's ranked specs / colour tiers |
| 5 | Product listings | Any JSON / CSV / XLSX export (nested ISQ spec arrays are fine) |

The app runs entirely in the browser with your own **OpenRouter**, **Groq** or **LiteLLM** key. Groq's
free tier (e.g. GPT-OSS 120B) has no per-token cost and is unusually fast, so it's a good way to test
prompt changes without spending anything. Groq retires and adds free-tier models on its own schedule
(it dropped Llama entirely from that tier in 2026) — check console.groq.com/docs/models if a Groq
model preset in this app ever comes back "does not exist."

## How a run works

The model never does arithmetic, and it only sees what code can't decide on its own.

```
keywords (1, 2) ─▶ code: parse → detect columns → normalise → mine terms
                        ├─ price words, places, sizes ──▶ labelled by code (free)
                        └─ remaining top 150 terms ──▶ model · step 1: label → dimension + value
                   code: total demand per dimension/value (coverage, top-value share)

listings (5) ────▶ code: flatten JSON → field rules (ignore ids/urls, name, price, unit, spec names)
                        └─ if ≥ 2 spec names ──▶ model · step 2: merge synonyms / drop non-specs
                   code: fill % per spec, common values, price quartiles

context (3) + ranking (4) + evidence ──▶ model · step 3: MASTER PROMPT → filters linked to evidence rows
                                          (judgement only — which filter, which tier, why; no options)
                   code: fill in coverage / share / fill %, options and UI pattern from the links,
                         auto-fix (Tier 1 = 3–5, real options, Tier 3 display-only, ISQ blockers)
                         and list every fix
```

Steps 1 and 2 run in parallel and are skipped when there's nothing for them to do.

**Watch it work.** Each run shows one card per step: what it does, its status and time, model calls with
tokens in/out and ₹ cost (or "no model call" / "reused · no cost"), and the step's numbers (terms mined,
labelled share, specs kept, filters per tier, auto-fixes…). **See the working** opens the exact input (the
prompt sent, or the data read) and output (the model's answer, or what code produced). **Re-run from here**
asks the model afresh for that step and everything that depends on it, and reuses the answers above it —
e.g. re-running the design step costs one call, and re-running the check step costs nothing.

**Order of evidence.** Filters start from what buyers search (keyword dimensions), are validated against the
category context and the CM ranking, and only then checked against listing fill rates. The dimension names used
to label keywords are **not a fixed list**: they come from the category itself — the specs in the CM ranking,
the spec names sellers fill in the listings (with their values) and an excerpt of the context doc — so demand,
ranking and fill rates all line up on the same names.

**Demo listings.** The "Listings are a demo sample" checkbox (on by default) keeps filters with low listing
fill rates in their tier and adds the fill rate to the rationale ("only 12% of sample listings fill this —
needs ISQ push") instead of demoting them.

**Include UI design.** Ticked by default. Filter options and UI pattern are always built by code from
the same evidence the model already links to (top keyword values, common listing values, price
quartiles) — the model never retypes an option list, so it spends its output budget on judgement and a
thorough rationale instead, regardless of this toggle. Untick it to also drop interaction rules and get
just the filter list — tiers, order, confidence and rationale; the table hides the UI columns and the
page preview.

## Cost

A typical run is **3 calls and about 5–9k input / around 3k output tokens** — well under ₹0.20 on the
default model, or free on Groq. The button bar shows a live estimate for your current inputs. The design
step is deliberately sized for a **thorough, well-justified answer over a minimal one** — it no longer
authors option lists (code does that from evidence, see skill 09), and that saved room goes toward a
fuller rationale, more specific interaction rules and real reasoning room, not toward a smaller bill.
What still keeps the *unavoidable* cost down, without shrinking the answer's quality:

| Saving | How |
|--------|-----|
| No arithmetic by the model | Code totals everything; the model gets compact tables, not raw rows |
| Fewer terms to label | Price words, cities/states and sizes are labelled by code; only the top 150 other terms go to the model, with no numbers |
| No option lists to write | Filters return evidence *links*; code fills the numbers, the options and the UI pattern from them — the model spends its output budget on judgement and rationale instead |
| Field mapping mostly free | Rules handle ids, URLs, names, prices, units and spec names; the model is called only to merge synonyms |
| No repair call | Tier limits, option clean-up, display-only and ISQ blockers are fixed in code |
| Reuse | Labelling and field-mapping answers are cached for the session — editing only the context doc or ranking and re-running costs one call |
| Cheapest routing | On OpenRouter, requests use `provider.sort = price`; reasoning is off for steps 1–2 and a "medium" budget (~3,000 tokens) for step 3, enough to reason through skill 08's method per candidate |
| Stable prompt prefix | System prompts come first and don't change between runs, so providers with automatic prompt caching bill repeats at the cached rate |
| Relevant context only | A long context doc is cut to the ~4,500 characters that mention this category's specs and buyer choice, not just its first page |
| Fits small models | Output room sized per step; if a provider says the prompt is too long, it's re-sent in a compact form automatically; stuck calls time out and retry on another provider |

**Model presets** (OpenRouter, all under ₹0.5 a run; the chip shows the live estimate):

| Preset | Price per M tokens (in / out) | Notes |
|--------|------------------------------|-------|
| Qwen 3.8 Flash | $0.03 / $0.13 | cheapest |
| DeepSeek V4 Flash | $0.07 / $0.14 | |
| DeepSeek V4.1 Flash | $0.15 / $0.60 | best results so far |
| GLM 5.3 Flash | $0.15 / $0.50 | strong, widely used flash model |
| Gemini 3.1 Flash Lite | $0.25 / $1.50 | long context, fast |

**Groq** (free tier, no per-token cost, rate-limited instead — good for testing without spending
anything; Groq changes its free-tier lineup on its own schedule, so treat these as current as of
Sep 2026, not permanent):

| Preset | Notes |
|--------|-------|
| GPT-OSS 120B | strongest free option, still fast |
| GPT-OSS 20B | fastest, lighter judgement |
| Qwen 3.6 27B | alternative if GPT-OSS is rate-limited |

If a provider rejects an optional parameter (JSON mode, reasoning, routing), the call is retried once without them.

## Skill docs — the prompts live in `src/skills/`

Every prompt is assembled from small markdown files, one per layer of the task, so you can improve one
layer without touching the others:

```
system prompt for a stage = base.md + the "## Prompt" section of each skill doc listed for that stage
```

| File | Layer | Used in |
|------|-------|---------|
| `base.md` | Shared context and ground rules | every stage |
| `01-parse-keyword-files.md` | Reading keyword exports, demand/action metrics | master prompt |
| `02-derive-specs-from-keywords.md` | Mining terms from keywords; code auto-labels; model labels the rest | step 1 |
| `03-demand-aggregation.md` | Coverage, top-value share, generic share | master prompt |
| `04-parse-product-json.md` | Flattening product JSON; field rules; merging spec synonyms | step 2 |
| `05-listing-spec-profile.md` | Fill rates, common values, price distribution (supply) | master prompt |
| `06-context-and-ranking.md` | Reading the context doc and CM ranking | master prompt |
| `07-filter-design-brief.md` | Master prompt role and goal | master prompt |
| `08-scoring-and-tiering.md` | Scoring, confidence, tiers, ordering | master prompt |
| `09-filter-options-and-ui.md` | Option lists & UI pattern — code only now, no prompt (see the file) | after step 3 |
| `10-rationale-and-output.md` | Rationale, rules, blockers, JSON schema, worked example | master prompt |
| `11-output-validation.md` | Code checks and automatic fixes (no prompt) | after step 3 |

Each skill doc has:

- a short header — what the layer does and which code implements it;
- `## What the code does` (deterministic layers) — behaviour you can change in the named function;
- `## Prompt` — the **only** part sent to the model. Everything else is for humans.

The stage → skill mapping is in `src/skills/index.ts` (`STAGES`). To add a skill, create the `.md`,
import it in `index.ts` and list it under a stage.

**View prompts** (next to Generate) shows the fully assembled prompt of every stage — the base prompt plus
the skill docs it's built from, with the file names — and the exact data sent. Before a run it previews
from your current inputs; after a run it shows what was actually sent.
The **Skill docs** toggle in that panel shows each markdown file in full.

## Output

- **Filter table** — tier, rank, name, UI pattern, options, confidence, rationale, supporting sources,
  coverage / top-value share / listing fill % (filled in by code), and ISQ gaps.
- **See it on a page** — a demo search page: Tier 1 in the filter bar, Tier 2 under "More filters",
  Tier 3 specs shown on the product cards.
- **Save results + download .md** — keeps runs on this device (reopen them from "View saved results").
- **Evidence** — the dimension/value demand tables and the listing spec profile the master prompt received.
- **Raw JSON**, **Export JSON**, **Export CSV**.
- **Warnings** — every automatic fix, and anything code couldn't fix.

## Code map

| Path | What |
|------|------|
| `src/lib/data.ts` | Parsing, column detection, term mining, aggregation, listing flattening & profiling (no model) |
| `src/lib/prompts.ts` | Builds each stage's user message (the data blocks) |
| `src/lib/llm.ts` | OpenRouter/LiteLLM client: JSON mode, reasoning budget, price routing (with fallback), retry on 429/5xx |
| `src/lib/filter-gen.ts` | The pipeline: prepare → label ∥ merge specs → design → link evidence & auto-fix; cache; cost estimate |
| `src/lib/export.ts` | Markdown export for saved runs |
| `src/components/SearchPreview.tsx` | Demo search page |
| `src/components/StepCards.tsx` | "Watch it work" step cards: status, time, tokens, cost, input/output, re-run |
| `src/skills/` | Skill docs and the prompt composer |
| `src/routes/index.tsx` | The page |

## Development

This project was built with [Lovable](https://lovable.dev) — continue in the
[Lovable editor](https://lovable.dev/projects/e81429cb-a496-4fd1-9755-593892d3f10b), or locally:

```sh
npm i
npm run dev      # http://localhost:8080
npm run lint
npm run build
```

Changes pushed to the connected branch sync back to Lovable.
