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

## Fitting the model (before any answer)

- **Output room** — `max_tokens` is sized to the job (labelling ≈ 10 per term up to 2,500; spec merge 1,000;
  design 4,000, or 2,500 with UI design off) so input + reserved output fits small-context providers.
- **Too long for the model** — if the provider says the prompt exceeds its context, the call is retried with
  less output room on any provider; if it still doesn't fit, the prompt is rebuilt with the **compact budget**
  (shorter context excerpt, fewer values/specs/terms) and a warning says so. The step card shows "compact prompt".
- **Stuck calls** — each attempt has a timeout (≈ 90 s + 15 ms per output token). A timed-out call is retried
  once without cheapest-provider routing, then fails with a clear message. Design-step thinking is capped at
  1,024 reasoning tokens.

Every automatic fix is listed under "Check these before using the output" so nothing changes silently.

Before the checks the answer is normalised: tiers like `1`/`"Tier 1"` → `Tier 1`, confidence casing fixed.
`total_keywords_analyzed` is always set by code. A reply that isn't valid JSON gets one "reply with
valid JSON only" retry (`chatJson()` in `src/lib/llm.ts`) — that is the only extra call that can happen.
