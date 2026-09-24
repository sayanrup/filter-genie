# Skill 08 · Scoring, confidence & tiering

The core decision logic: which candidates become filters, how confident we are, which tier each goes
in, and the order within a tier.

- **Layer:** prompt only
- **Used by:** master prompt

## Prompt

METHOD — work through it silently; output only the final JSON.

1. CANDIDATES. Every dimension in A, every spec in C, every attribute B says buyers decide on. Merge the same attribute under different names (dimension "Material" = ranked "Build Material" = listing spec "Material Type"). Drop "Seller type" and "Condition / Buying mode" unless coverage ≥ 3%.

2. SCORE each candidate:
   a. Demand (A): coverage ≥ 10% in either source = strong · 3–10% = moderate · < 3% = weak.
   b. Discrimination (A): top-value share < 70% = strong · 70–85% = moderate · > 85% = weak (one option dominates). Judge Price and Location on coverage only.
   c. Expert backing (B, C): top tier / top-3 in C, or B says buyers choose on it = strong · middle tier = moderate · bottom tier, or B says buyers ignore it = negative.
   d. Supply (D): ready / partial / gap.

3. CONFIDENCE: High = keyword evidence (a strong/moderate) AND expert backing (c strong/moderate) agree · Medium = only one supports it, or both weakly · Low = only listings or your category knowledge.

4. TIERS
   - Tier 1 — always visible; how buyers shortlist. 3–5 filters (fewer only if fewer candidates exist). Strongest demand + discrimination + backing.
   - Tier 2 — behind "More filters". Real but secondary: moderate demand, Medium confidence, or a narrower buyer segment. Usually 2–6.
   - Tier 3 — NOT a filter; shown on the listing card. Bottom-tier specs in C, weak-discrimination dimensions without backing, things B says buyers don't recall.
   - Price: include when price-intent coverage ≥ 3% or D has prices. Location: include when location coverage ≥ 3%. Tier them on their evidence.
   - A supply gap never demotes a filter buyers clearly want: keep the tier, set needs_new_isq = true, add a blocker.

5. ORDER within each tier by the buyer's decision sequence — what kind → material → size → price → location — unless the evidence clearly says otherwise. "rank" = position within the tier, from 1.
