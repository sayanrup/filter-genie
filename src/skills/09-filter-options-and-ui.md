# Skill 09 · Filter options & UI pattern

How each filter's option list and UI control are built. **This used to be a prompt layer — the model
wrote out 4–10 option strings and picked a UI pattern per filter.** That's now done in code from the
same evidence (A's dimension values, D's listing values, price quartiles), because code can only
ever copy or bucket values it already has, so asking a model to retype them added output tokens
and latency for no judgement gained. The model still decides *which filters exist*, at which tier
and why (skill 08) — it just no longer authors their option lists.

- **Layer:** code (deterministic) — no prompt section; left out of the master prompt entirely
- **Used by:** the check step, after the master prompt answers
- **Code:** `src/lib/filter-gen.ts` → `deriveOptions()`, called from `attachEvidence()`

## What the code does

- **Tier 3** (display-only): up to 4 of the listing spec's most common values (D), or `[]` if the
  filter has no matching spec. `ui_pattern` is always `"display only"`.
- **Price**: buckets built from D's price quartiles (min · 25th · median · 75th · max), each pair
  turned into an Indian-format range (`₹50,000 – ₹1.5 Lakh`) with the price unit; `[]` if there
  aren't enough priced listings. `ui_pattern` = `"range slider with presets"`.
- **Location**: the union of the dimension's values (A) and the listing spec's common values (D),
  capped at 10. `ui_pattern` = `"location search"`.
- **Everything else**: starts from the linked dimension's values in A, ranked by demand; falls back
  to the listing spec's common values in D when there's no keyword dimension. Values under ~3% share
  of the dimension fold into `"Other"`; kept to 8 before folding. `ui_pattern` is then picked from
  the shape of what's left: all-numeric values → `"range buckets"`; ≤ 4 values → `"single-select"`;
  otherwise → `"multi-select checkboxes"`. A filter left with 0–1 options is caught by `fixResult()`
  and demoted to Tier 3, same as before.
- **Override**: if the model's JSON still includes a non-empty `"values"` for a filter (an older
  prompt version, or a manual edit to the schema), code leaves it alone instead of overwriting it —
  see the check in `attachEvidence()`. This is also how to fully revert to model-authored options:
  restore this file's previous prompt section and skill 10's schema from git history, and the
  override path picks the model's values back up automatically.
- `MAX_OPTIONS` (12) and the "< 2 options → Tier 3" rule are still enforced by `fixResult()` in code,
  exactly as before, whichever path produced the values.

## Prompt

(none — this layer no longer sends any instructions to the model.)
