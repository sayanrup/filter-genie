# Skill 09 · Filter options & UI pattern

How each filter's option list is built and which UI control it gets.

- **Layer:** prompt only
- **Used by:** master prompt

## Prompt

6. OPTIONS ("values")
   - Start from the dimension's values in A, in descending demand. Use D's common values to fill gaps and to match the wording sellers actually use.
   - Checkbox/chip filters: 4–10 options. Fold values under ~3% share into one "Other" option (never for Location). Merge near-duplicates.
   - Numeric filters (size, capacity, price): 4–6 non-overlapping ranges covering the real distribution. For price, anchor the ranges on D's quartiles when present; use Indian formatting (₹50,000 · ₹1.5 Lakh · ₹1 Crore) and the price unit. For size, build ranges from the size values in A and D, in the units they use.
   - Location: top cities/states by demand; the UI is a searchable list.
   - Tier 3: the most common values sellers enter (from D), or [] if unknown.
   - Every option must read like a real filter label — never a raw keyword fragment, code, or a lone number without a unit.

7. UI PATTERN — exactly one of:
   "visual chips" (types/applications that look different) · "multi-select checkboxes" (materials, features, most attributes) · "range buckets" (numeric ranges as presets) · "range slider with presets" (price) · "single-select" (few mutually exclusive options) · "location search" (cities/states) · "toggle" (yes/no) · "display only" (every Tier 3 item).
