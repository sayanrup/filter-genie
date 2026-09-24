# Skill 09 · Filter options & UI pattern

How each filter's option list is built and which UI control it gets.

- **Layer:** prompt only
- **Used by:** master prompt — left out when **Include UI design** is unticked; the master prompt then
  asks for filters, tiers, confidence and rationale only (`ui_pattern` "", `values` [], no interaction rules)

## Prompt

7. OPTIONS ("values")
   - Start from the dimension's values in A (in order); use D's common values to fill gaps and match seller wording.
   - Checkbox/chip filters: 4–10 options; fold values under ~3% share into "Other" (never for Location); merge near-duplicates.
   - Numeric (size, capacity, price): 4–6 non-overlapping ranges covering the real distribution. Price from D's quartiles, Indian format (₹50,000 · ₹1.5 Lakh · ₹1 Crore) with the price unit. Size in the units used in A and D.
   - Location: top cities/states by demand. Tier 3: the commonest seller values from D, or [].
   - Every option must read like a real filter label: no keyword fragments, codes or bare numbers without units.
8. UI PATTERN, exactly one of: "visual chips" (types that look different) · "multi-select checkboxes" (most attributes) · "range buckets" (numeric presets) · "range slider with presets" (price) · "single-select" (few exclusive options) · "location search" · "toggle" (yes/no) · "display only" (every Tier 3).
