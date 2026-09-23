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

The app runs entirely in the browser with your own **OpenRouter** or **LiteLLM** key.

## How a run works

The model never does arithmetic. Code totals the numbers; the model labels and judges.

```
                    ┌──────────────── code (src/lib/data.ts) ────────────────┐
keywords (1, 2) ──▶ parse → detect columns → normalise → mine terms ──┐        │
                    └───────────────────────────────────────────────┼────────┘
                                                                     ▼
                                    model · stage 1: label terms → dimension + value
                                                                     ▼
                    code: total demand per dimension/value (coverage, top-value share)
                                                                     │
listings (5) ─────▶ code: flatten JSON → field summary               │
                         ▼                                           │
                    model · stage 2: map fields → canonical specs    │
                         ▼                                           │
                    code: fill % per spec, common values, price quartiles
                                                                     ▼
context (3) + ranking (4) + all evidence ──▶ model · stage 3: MASTER PROMPT → filter panel JSON
                                                                     ▼
                    code: validate (Tier 1 = 3–5, real options, cited evidence …)
                          └─ if anything fails → one repair turn → warnings for what's left
```

Stages 1 and 2 run in parallel. A full run is 2–4 model calls. If stage 1 or 2 fails, the run carries on
with raw term totals / raw field names and says so in the warnings.

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
| `02-derive-specs-from-keywords.md` | Mining terms from keywords; labelling them as dimension + value | stage 1 |
| `03-demand-aggregation.md` | Coverage, top-value share, generic share | master prompt |
| `04-parse-product-json.md` | Flattening product JSON; mapping fields to canonical specs | stage 2 |
| `05-listing-spec-profile.md` | Fill rates, common values, price distribution (supply) | master prompt |
| `06-context-and-ranking.md` | Reading the context doc and CM ranking | master prompt |
| `07-filter-design-brief.md` | Master prompt role and goal | master prompt |
| `08-scoring-and-tiering.md` | Scoring, confidence, tiers, ordering | master prompt |
| `09-filter-options-and-ui.md` | Option lists, numeric ranges, UI pattern | master prompt |
| `10-rationale-and-output.md` | Rationale, rules, blockers, JSON schema, worked example | master prompt |
| `11-output-validation.md` | Code checks and the repair-turn instruction | repair turn |

Each skill doc has:

- a short header — what the layer does and which code implements it;
- `## What the code does` (deterministic layers) — behaviour you can change in the named function;
- `## Prompt` — the **only** part sent to the model. Everything else is for humans.

The stage → skill mapping is in `src/skills/index.ts` (`STAGES`). To add a skill, create the `.md`,
import it in `index.ts` and list it under a stage.

**View prompts** (next to Generate) shows the fully assembled prompt of every stage — the base prompt plus
the skill docs it's built from, with the file names — and the exact data sent. Before a run it previews
from your current inputs; after a run it shows what was actually sent, including any repair turn.
The **Skill docs** toggle in that panel shows each markdown file in full.

## Output

- **Filter table** — tier, rank, name, UI pattern, options, confidence, rationale, supporting sources,
  coverage / top-value share / listing fill %, and ISQ gaps.
- **Evidence** — the dimension/value demand tables and the listing spec profile the master prompt received.
- **Raw JSON**, **Export JSON**, **Export CSV**.
- **Warnings** — anything the validator still flags after the repair turn.

## Code map

| Path | What |
|------|------|
| `src/lib/data.ts` | Parsing, column detection, term mining, aggregation, listing flattening & profiling (no model) |
| `src/lib/prompts.ts` | Builds each stage's user message (the data blocks) |
| `src/lib/llm.ts` | OpenRouter/LiteLLM client: JSON mode with fallback, retry on 429/5xx, JSON extraction |
| `src/lib/filter-gen.ts` | The pipeline: prepare → label ∥ map fields → design → validate/repair |
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
