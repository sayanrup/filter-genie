# Skill 11 · Output validation & automatic fixes

Checks the master prompt's answer in code and fixes what it can deterministically. Anything it can't fix
is shown to the user as a warning.

- **Layer:** code only (no `## Prompt` section — nothing here is sent to the model)
- **Used by:** after the master prompt
- **Code:** `src/lib/filter-gen.ts` → `normalizeResult()`, `attachEvidence()`, `fixResult()`

## Checks and automatic fixes

All in code — **no second model call** (a repair turn would resend the whole prompt and double the cost).

| Check | Automatic fix |
|-------|---------------|
| Tier 1 has more than 5 filters | lowest-ranked extras move to Tier 2 |
| Tier 1 has fewer than 3 (and ≥ 3 filterable exist) | best Tier 2 filters (by confidence, then rank) are promoted |
| A Tier 1/2 filter has fewer than 2 options | moved to Tier 3 (display only) |
| More than 12 options | kept the first 11 + "Other" |
| Options that are bare numbers or single characters | removed |
| Tier 3 without `display only` | ui_pattern set to `display only` |
| Duplicate filter names | later duplicates removed |
| Ranks with gaps or repeats | renumbered 1…n within each tier, keeping order |
| `dimension` / `listing_spec` not found in the evidence | link cleared (numbers stay empty) |
| Rationale with no number and no named source | **warning only** |
| needs_new_isq without a matching blocker | a blocker is added from `isq_note` |

Every automatic fix is listed under "Check these before using the output" so nothing changes silently.

Before the checks the answer is normalised: tiers like `1`/`"Tier 1"` → `Tier 1`, confidence casing fixed.
`total_keywords_analyzed` is always set by code. A reply that isn't valid JSON gets one "reply with
valid JSON only" retry (`chatJson()` in `src/lib/llm.ts`) — that is the only extra call that can happen.
