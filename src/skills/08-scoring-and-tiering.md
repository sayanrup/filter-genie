# Skill 08 · Scoring, confidence & tiering

The core decision logic: which candidates become filters, how confident we are, which tier each goes
in, and the order within a tier.

- **Layer:** prompt only
- **Used by:** master prompt

## Prompt

METHOD — work through it silently; output only the final JSON.

1. CANDIDATES. List every dimension in A, every spec in C, and every attribute B says buyers decide on. Merge candidates that are the same attribute under different names (keyword dimension "Material" = ranked spec "Build Material" = listing field "Material Type"). Drop "Seller type" and "Condition / Buying mode" unless coverage ≥ 3%.

2. SCORE each candidate on four signals:
   a. Demand (A): coverage ≥ 10% in either source = strong · 3–10% = moderate · < 3% = weak · absent = none.
   b. Discrimination (A): top-value share < 70% = strong · 70–85% = moderate · > 85% = weak (one option dominates, so the filter barely narrows). Price and Location are intent dimensions — judge them on coverage only.
   c. Expert backing (B, C): top tier or top-3 in C, or B says buyers choose on it = strong · middle tier = moderate · bottom tier, or B says buyers ignore it = negative.
   d. Supply (D, only when present): ready / partial / gap, per evidence D.

3. CONFIDENCE
   - High — keyword evidence (a strong/moderate) AND expert backing (c strong/moderate) agree.
   - Medium — only one of those two supports it, or both do but weakly.
   - Low — supported only by listings or by your category knowledge.

4. TIERS
   - Tier 1 — always visible; how buyers shortlist. 3 to 5 filters, never more, never fewer (unless fewer than 3 candidates exist at all). The strongest combination of demand, discrimination and backing.
   - Tier 2 — behind "More filters". Real but secondary: moderate demand, Medium confidence, or relevant to a narrower buyer segment. Usually 2–6 filters.
   - Tier 3 — NOT a filter; shown on the listing card / product page. Bottom-tier specs from C, weak-discrimination dimensions without expert backing, and anything B says buyers don't recall (e.g. brand in an unbranded category).
   - Price and Location are near-universal in B2B. Include Price when price-intent coverage ≥ 3% OR D has price data; include Location when location coverage ≥ 3%. Tier them on their evidence like everything else.
   - A supply gap doesn't demote a filter buyers clearly want: keep its tier, set needs_new_isq = true, and add a blocker.

5. ORDER within each tier by the buyer's decision sequence — what kind → what it's made of → how big → how much → where from — unless the evidence clearly says otherwise (e.g. price coverage beats every other dimension). "rank" = position within its tier, starting at 1.
