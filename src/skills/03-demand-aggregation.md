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
- In the prompt, to save tokens (`BUDGETS` in `src/lib/prompts.ts`): up to 8 values per dimension and at most
  2 rate columns; dimensions under 1% coverage in every source are summarised on one line; top 8 keywords per
  source. The compact budget (automatic retry for small-context models) uses 5 values, no rates, top 5.
- After the master prompt answers, `attachEvidence()` looks up each filter's `dimension` here to fill
  `coverage_pct` / `top_value_share_pct` — the model never copies these numbers.

## Prompt

READING THE DIMENSION TABLES (A):
- coverage = % of a source's demand whose keywords state this dimension (how often buyers ask for it up front).
- top-value share = % of the dimension's demand held by its biggest value. Low = buyers split across options, so the filter narrows results; high = one option dominates.
- per value: demand, share of the dimension, action metric and rates when present; highest demand first. Dimensions under 1% coverage are listed on one "minor" line.
- generic share = % of demand with no qualifier at all (buyers who rely most on filters).
- "Price intent" = how often buyers mention price; Price ranges come from listing prices (D), not keywords.
- If raw term totals are given instead of dimensions, terms overlap inside keywords: cite them individually, never add them up.
