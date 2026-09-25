# Skill 05 · Listing spec profile (supply side)

Measures what sellers actually fill in today: per canonical spec, the fill rate and the most common
values, plus the price distribution. This is the *supply* check — a filter on a spec sellers don't fill
returns empty results.

- **Layer:** code (deterministic) + a prompt section for the design model
- **Used by:** master prompt (evidence D)
- **Code:** `src/lib/data.ts` → `profileListings()`; `src/lib/prompts.ts` → `formatListing()`
- **Field mapping:** see skill 04 (code rules + optional model merge)

## What the code does

- Source fields mapped to the same spec are merged; a listing counts as filled if any of them has a value
  (`-`, `NA`, `null`, empty don't count).
- Values are grouped case-insensitively; top 8 per spec are kept (the Evidence tab shows all 8).
- In the prompt, to save tokens: only specs filled on ≥ 5% of listings (≥ 1% for a demo sample; max 25, or 12
  in the compact budget) get a row with their top 4 values (24 characters each); rarer specs are listed by
  name and fill % on one line.
- Price: first number in the price field, with the unit from a unit field or the text after `/`.
  Quartiles (min / 25th / median / 75th / max) use only listings quoting the **most common unit** —
  mixing "per piece" and "per sq ft" prices would make the ranges meaningless; the rest are counted and
  mentioned.

## Prompt

EVIDENCE D · LISTING SPEC PROFILE (supply): per spec its fill % of listings, distinct values and most common values with counts; plus price quartiles with their unit.
- Fill ≥ 60% = ready · 30–60% = partial (launch, flag it) · < 30% or missing = gap (needs a new or mandatory ISQ).
- Name options the way sellers enter them; set price ranges from the quartiles.
