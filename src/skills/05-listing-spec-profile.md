# Skill 05 · Listing spec profile (supply side)

Measures what sellers actually fill in today: per canonical spec, the fill rate and the most common
values, plus the price distribution. This is the *supply* check — a filter on a spec sellers don't fill
returns empty results.

- **Layer:** code (deterministic) + a prompt section for the design model
- **Used by:** master prompt (evidence D)
- **Code:** `src/lib/data.ts` → `profileListings()`; `src/lib/prompts.ts` → `formatListing()`

## What the code does

- Source fields mapped to the same spec are merged; a listing counts as filled if any of them has a value
  (`-`, `NA`, `null`, empty don't count).
- Values are grouped case-insensitively; top 8 per spec are kept.
- Price: first number in the price field; min / 25th / median / 75th / max over listings with a price,
  and the most common unit (from a unit field or the text after `/`).

## Prompt

EVIDENCE D · LISTING SPEC PROFILE — for current listings: each spec's fill % (filled / total), number of distinct values, most common values with counts, and the price distribution (quartiles) with its unit. This is supply:
- fill ≥ 60% = ready to launch as a filter · 30–60% = partial (launch, but flag it) · < 30% or spec missing = gap (needs a new or mandatory ISQ).
- Use the common values to name filter options the way sellers actually enter them.
- Use the price quartiles to set price ranges.
