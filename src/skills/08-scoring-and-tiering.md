# Skill 08 · Scoring, confidence & tiering

The core decision logic: which candidates become filters, how confident we are, which tier each goes
in, and the order within a tier.

- **Layer:** prompt only
- **Used by:** master prompt

## Prompt

METHOD (work silently; output only the JSON)
1. START FROM WHAT BUYERS SEARCH: candidates = the dimensions in A, by coverage.
   Demand: coverage ≥ 10% in either source = strong · 3–10% = moderate · < 3% = weak.
   Discrimination: top-value share < 70% = strong · 70–85% = moderate · > 85% = weak. Judge Price and Location on coverage only.
2. VALIDATE WITH B AND C:
   Confirmed (C top tier/top 3, or B says buyers choose on it) → raise priority. Neutral (C middle, B silent) → keep on keyword evidence. Contradicted (C bottom, or B says buyers ignore it) → Tier 3 unless demand is strong.
   ADD specs B or C call decisive that buyers don't type: usually Tier 2, Tier 1 only if both B and C insist.
   Merge one attribute under different names (keyword "Material" = ranked "Build Material" = listing "Material Type"). Drop "Seller type" and "Condition / Buying mode" below 3% coverage.
3. CHECK SUPPLY IN D: fill < 30% or missing → needs_new_isq = true plus a blocker. Supply never removes a filter buyers want; it only flags ISQ work.
4. CONFIDENCE: High = keyword evidence strong/moderate AND B or C confirms · Medium = only one supports it, or both weakly · Low = only listings or category knowledge.
5. TIERS
   Tier 1 (always visible, how buyers shortlist): 3–5 filters with the strongest demand, discrimination and confirmation.
   Tier 2 (under "More filters"): real but secondary; moderate demand, Medium confidence, context-only specs, niche segments. Usually 2–6.
   Tier 3 (not a filter, shown on the listing card): contradicted, weak-discrimination without backing, bottom tier in C.
   Price: include if price-intent coverage ≥ 3% or D has prices. Location: include if coverage ≥ 3%.
6. ORDER within a tier by the buyer's decision sequence (kind → material → size → price → location) unless evidence says otherwise. "rank" = position within the tier, from 1.
