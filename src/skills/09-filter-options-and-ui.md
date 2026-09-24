# Skill 09 · Filter options & UI pattern

How each filter's option list is built and which UI control it gets.

- **Layer:** prompt only
- **Used by:** master prompt — left out when **Include UI design** is unticked; the master prompt then
  asks for filters, tiers, confidence and rationale only (`ui_pattern` "", `values` [], no interaction rules)

## Prompt

7. OPTIONS ("values")
   - Start from the dimension's values in A, in the order given (highest demand first). Use D's common values to fill gaps and match sellers' wording.
   - Checkbox/chip filters: 4–10 options; fold values under ~3% share into "Other" (never for Location); merge near-duplicates.
   - Numeric filters (size, capacity, price): 4–6 non-overlapping ranges covering the real distribution. Price: anchor on D's quartiles, Indian formatting (₹50,000 · ₹1.5 Lakh · ₹1 Crore) and the price unit. Size: from the size values in A and D, in their units.
   - Location: top cities/states by demand (the UI is a searchable list).
   - Tier 3: the most common values sellers enter (D), or [].
   - Every option must read like a real filter label — never a keyword fragment, code, or a bare number without a unit.

8. UI PATTERN — exactly one of: "visual chips" (types that look different) · "multi-select checkboxes" (materials, features, most attributes) · "range buckets" (numeric presets) · "range slider with presets" (price) · "single-select" (few exclusive options) · "location search" · "toggle" (yes/no) · "display only" (every Tier 3 item).
