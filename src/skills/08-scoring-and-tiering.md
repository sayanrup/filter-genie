# Skill 08 · Scoring, confidence & tiering

The core decision logic: which candidates become filters, how confident we are, which tier each goes
in, and the order within a tier.

- **Layer:** prompt only
- **Used by:** master prompt

## Prompt

METHOD — work through these steps in order, silently; output only the final JSON.

1. START FROM WHAT BUYERS SEARCH (A). The candidate list is the keyword dimensions in A, in order of coverage. These are the specs buyers actually type. Each one carries its demand (coverage) and discrimination (top-value share):
   a. Demand: coverage ≥ 10% in either source = strong · 3–10% = moderate · < 3% = weak.
   b. Discrimination: top-value share < 70% = strong · 70–85% = moderate · > 85% = weak (one option dominates). Judge Price and Location on coverage only.

2. VALIDATE WITH THE CATEGORY CONTEXT (B) AND THE CM RANKING (C). For each keyword candidate decide whether it really matters for this category:
   - Confirmed: C ranks it in the top tier / top-3, or B says buyers choose on it → keep, raise priority.
   - Neutral: middle tier in C, or B is silent → keep on keyword evidence alone.
   - Contradicted: bottom tier in C, or B says buyers ignore it (e.g. brand in an unbranded category) → demote (Tier 3) unless demand is strong.
   Then ADD specs that B or C call decisive but buyers don't type (no keyword dimension) — usually Tier 2, Tier 1 only when both B and C insist. Merge the same attribute under different names (keyword "Material" = ranked "Build Material" = listing "Material Type"). Drop "Seller type" and "Condition / Buying mode" unless coverage ≥ 3%.

3. CHECK SUPPLY (D). Look up each surviving candidate's fill % in the listing profile: ≥ 60% = ready · 30–60% = partial · < 30% or missing = gap (needs_new_isq = true + a blocker). Supply never removes a filter buyers want — it only flags the ISQ work needed.

4. CONFIDENCE: High = keyword evidence (a strong/moderate) AND context/ranking confirm · Medium = only one of them supports it, or both weakly · Low = only listings or your category knowledge.

5. TIERS
   - Tier 1 — always visible; how buyers shortlist. 3–5 filters (fewer only if fewer candidates exist). Strongest demand + discrimination + confirmation.
   - Tier 2 — behind "More filters". Real but secondary: moderate demand, Medium confidence, context-only specs, or a narrower buyer segment. Usually 2–6.
   - Tier 3 — NOT a filter; shown on the listing card. Contradicted specs, weak-discrimination dimensions without backing, bottom-tier specs in C.
   - Price: include when price-intent coverage ≥ 3% or D has prices. Location: include when location coverage ≥ 3%. Tier them on their evidence.

6. ORDER within each tier by the buyer's decision sequence — what kind → material → size → price → location — unless the evidence clearly says otherwise. "rank" = position within the tier, from 1.
