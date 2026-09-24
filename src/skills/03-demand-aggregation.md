# Skill 03 · Demand aggregation (dimension & value tables)

Applies the term labels from skill 02 back onto every keyword and totals demand per filter
dimension and value — the numbers the master prompt quotes in its rationales.

- **Layer:** code (deterministic) + a prompt section that defines the metrics for the design model
- **Used by:** master prompt (evidence A)
- **Code:** `src/lib/data.ts` → `aggregate()`; `src/lib/prompts.ts` → `formatDimensions()`

## What the code does

- Matches labelled terms inside each keyword, **longest match first** (so "mild steel" isn't also
  counted as "steel"). A keyword can hit several dimensions, and several values of one dimension.
- Per dimension and source: keywords, demand, action, **coverage** (% of the source's total demand
  whose keywords carry the dimension) and **top-value share** (% of the dimension's demand held by its
  biggest value). A keyword that hits two values counts once towards the dimension total.
- Per value: keywords, demand, action, share of the dimension, demand-weighted rates.
- **Generic share:** % of demand from keywords with no labelled qualifier at all.
- Sources are never mixed: internal pageviews and SERP clicks are reported side by side (`INT` / `SERP` columns).
- In the prompt, to save tokens: up to 12 values per dimension; dimensions under 1% coverage in every source
  are summarised on one line; top 10 keywords per source.
- After the master prompt answers, `attachEvidence()` looks up each filter's `dimension` here to fill
  `coverage_pct` / `top_value_share_pct` — the model never copies these numbers.

## Prompt

HOW TO READ THE DIMENSION TABLES (evidence A):
- coverage — % of a source's total demand whose keywords state this dimension. How often buyers ask for it up front.
- top-value share — % of the dimension's demand held by its single biggest value. Low = buyers split across options = the filter really narrows results. High = one option dominates.
- per value — keywords, demand, share of the dimension, action metric and rates when present.
- generic share — % of demand from keywords with no qualifier at all: buyers who will rely on filters the most.
- "Price intent" rows measure how often buyers mention price at all; the Price filter's ranges come from listing prices (evidence D), not from keywords.
- Values are listed highest demand first; dimensions with coverage under 1% are summarised on one "minor" line.
- If the evidence says terms could not be grouped, you receive raw term totals instead. Terms overlap inside keywords, so never add them up — cite them individually.
