# Skill 11 · Output validation & repair

Checks the master prompt's answer in code and, if anything fails, sends **one** repair turn listing the
problems. Whatever still fails afterwards is shown to the user as a warning.

- **Layer:** code (checks) + prompt (the repair turn's closing instruction)
- **Used by:** repair turn (only when a check fails)
- **Code:** `src/lib/filter-gen.ts` → `normalizeResult()`, `validateResult()`; `src/lib/prompts.ts` → `buildRepairUser()`

## Checks

- Tier 1 has 3–5 filters (when at least 3 filterable candidates exist).
- Tier 1/2 filters have ≥ 2 options; no filter has > 15; no option is a lone number or single character.
- Every rationale contains a number or names its source.
- Tier 3 items use `display only`.
- No duplicate filter names.

Before validation, the answer is normalised: tiers like `1`/`tier1` → `Tier 1`, confidence casing fixed,
numeric strings converted. `total_keywords_analyzed` is always set by code, not the model.
Non-JSON replies get one "reply with valid JSON only" retry (`chatJson()` in `src/lib/llm.ts`).

## Prompt

Fix every problem listed above using only the evidence already given — keep everything that was right — and reply with the complete corrected JSON object, nothing else.
