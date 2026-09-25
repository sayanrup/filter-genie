# Skill 08 · Scoring, confidence & tiering

The core decision logic: which candidates become filters, how confident we are, which tier each goes
in, and the order within a tier.

- **Layer:** prompt only
- **Used by:** master prompt

## Notes for editors

Rewritten as a numbered, single-rule-per-line method instead of dense paragraphs, plus a worked
walkthrough of the *reasoning* (not just the output format — skill 10 already has that). Smaller
models follow a short list of atomic rules more reliably than the same rules merged into prose; the
content and the actual thresholds are unchanged from the previous version — only the presentation.

## Prompt

METHOD — work through steps 1–7 for every candidate. Reason carefully; a short internal chain of
thought per candidate is fine, but the reply itself is still the JSON object only.

STEP 1 — CANDIDATES FROM DEMAND (evidence A):
- A candidate is any dimension present in A. Coverage = strong ≥ 10%, moderate 3–10%, weak < 3% (either source).
- Discrimination (how much the filter would narrow results) = strong if top-value share < 70%, moderate 70–85%, weak > 85%.
- Judge Price and Location on coverage only — they have no "top value" to be dominated by.

STEP 2 — VALIDATE AGAINST CONTEXT (B) AND RANKING (C), for each candidate from step 1:
- CONFIRMED: C ranks it top tier / top 3, OR B says buyers choose on it. → priority up.
- NEUTRAL: C ranks it middle, B says nothing about it. → keep it exactly as demand alone would rank it.
- CONTRADICTED: C ranks it bottom tier, OR B says buyers ignore it. → send to Tier 3 unless demand is strong.
- One real attribute can appear under different names across A, C and D (keyword "Material" = ranked "Build
  Material" = listing spec "Material Type") — that is ONE candidate, not three; merge them before scoring.
- Drop "Seller type" and "Condition / Buying mode" if their coverage in A is below 3%.

STEP 3 — SPECS B OR C ADD THAT BUYERS DON'T SEARCH FOR:
- These have no row in A (zero keyword coverage) — that is expected, not a strike against them.
- Default new tier: Tier 2. Promote to Tier 1 only when BOTH B and C insist on it, not just one.

STEP 4 — CHECK SUPPLY (D), for every candidate still in play after steps 1–3:
- Fill % < 30, or the spec is missing from D entirely → needs_new_isq = true, plus a blocker naming it.
- Never remove or demote a filter for low supply — buyers still want it; low supply only means ISQ work
  is needed before launch. (Tiering itself only looks at steps 1–3.)

STEP 5 — CONFIDENCE, from steps 1–2 only:
- High: demand strong or moderate (step 1) AND confirmed by B or C (step 2).
- Medium: only one of those two holds, or both hold weakly.
- Low: no keyword evidence at all — the filter rests on listings or general category knowledge alone.

STEP 6 — ASSIGN TIERS, using the outcome of steps 1, 2 and 3 (never step 4 — supply doesn't affect tier):
- Tier 1 (always visible; how buyers shortlist): the 3–5 candidates with the strongest combination of
  demand (step 1), discrimination (step 1) and confirmation (step 2). A step-3 add reaches Tier 1 only
  if both B and C insisted on it.
- Tier 2 (under "More filters"): everything real but secondary — moderate demand, Medium confidence,
  context/ranking-only specs from step 3, niche segments. Usually 2–6 filters.
- Tier 3 (not a filter — shown on the listing card instead): contradicted in step 2, or weak
  discrimination with no confirmation, or bottom tier in C.
- Price: include (in whichever tier its evidence earns) if price-intent coverage in A ≥ 3%, or D has
  enough priced listings. Location: include if coverage in A ≥ 3%.

STEP 7 — ORDER WITHIN EACH TIER:
- Default order follows the buyer's decision sequence: kind → material → size → price → location.
- Override the default only when the evidence itself says buyers decide in a different order for this
  category. "rank" in the output = position within the tier, starting at 1.

THREE WORKED WALKTHROUGHS (reasoning, not the output format — see skill 10 for the JSON):

1) CONFIRMED, strong on every count → Tier 1.
Evidence: A shows "Material" at INT coverage 31.2%, top-value share 46.3%. C ranks "Material" #2 of 7.
→ Step 1: coverage 31.2% ≥ 10% → strong demand; share 46.3% < 70% → strong discrimination.
→ Step 2: C top-3 → CONFIRMED.
→ Step 5: strong demand + confirmed → High confidence.
→ Step 6: strong demand + strong discrimination + confirmed → a Tier 1 candidate.
This is the same filter worked all the way to its JSON in skill 10's example.

2) CONTRADICTED, weak demand → Tier 3, not dropped.
Evidence: A shows "Seller Type" at coverage 2.1% (below the 3% weak/moderate line), top-value share 91%
(one value dominates). C ranks "Seller Type" in the bottom tier. B does not mention it.
→ Step 1: coverage 2.1% < 3% → weak demand; share 91% > 85% → weak discrimination.
→ Step 2: C bottom tier → CONTRADICTED; demand is weak, not strong, so this does send it down.
→ Step 5: weak demand, not confirmed → Low confidence.
→ Step 6: weak on both axes and contradicted → Tier 3 (still shown, on the listing card, not dropped).
This is a real attribute with real evidence — it becomes a display field, never a "not enough data" gap.

3) A B/C ADD with zero keyword demand → Tier 2 unless both insist.
Evidence: "Material" has no row in A at all (buyers never type it as a keyword). C ranks it #4 of 9
(middle tier). B's notes say buyer interviews mention it but don't call it a first-choice filter.
→ Step 1: no candidate from A — this only exists because of step 3.
→ Step 3: C middle tier alone (not both B and C insisting) → default to Tier 2, not Tier 1.
→ Step 5: no keyword evidence at all → Low confidence (per step 5's definition), even though it's real.
→ Step 6: a step-3 add without both B and C insisting stays in Tier 2.
Contrast with case 1: identical spec name, but here it reaches the panel only through steps 2–3, not
demand, so it is confidence Low / Tier 2 rather than High / Tier 1 despite also being "confirmed" by C.
