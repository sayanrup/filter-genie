# Skill 02 · Derive specifications from search keywords

Finds which product attributes buyers type into search, and what values they use. The code mines
candidate *terms* from all keywords; the model labels each term with a filter **dimension** and a clean
buyer-facing **value**. The code then adds up demand per value (skill 03).

- **Layer:** code (term mining) + prompt (labelling stage — its own model call)
- **Used by:** step 1 · keyword term labelling (skipped when code labelled every term)
- **Code:** `src/lib/data.ts` → `mineTerms()`; `src/lib/prompts.ts` → `buildTermLabelUser()`

## What the code does

1. Merges simple plurals (`cabins` → `cabin`) when both forms occur.
2. Detects **core words** — words in ≥ 40% of keywords (the category name itself) — and excludes them.
   Price words, places and sizes are never treated as core, however frequent.
3. Collects single words and recurring two-word phrases with, per source: keyword count, demand, action
   totals and the highest-demand example keyword.
4. **Labels the obvious terms itself, for free** (`autoLabel()` in `data.ts`):
   - price words (price, cost, rate, cheap, budget, rs, quotation…) → `Price: Price intent`
   - Indian cities/states and "near me" → `Location: <place>` (spelling variants merged: Bangalore → Bengaluru)
   - sizes (`20ft`, `10x10ft`, `1000l`) → `Size / Capacity: 20 ft`, `10 x 10 ft`, `1000 L`
   Phrases containing such a word are dropped (the word is counted on its own).
5. Sends only the remaining terms — the top 150 by share of demand — to the model, as `term | example`.
   No numbers are sent: the model doesn't need them to label.
6. **Dimensions are dynamic** (`dimensionCandidates()`): the model gets the category's own dimension names —
   the spec names parsed from the CM ranking, the listing spec names filled on ≥ 3% of listings with their
   common values, and a 1,200-character excerpt of the category context doc (the passages that mention those
   specs or how buyers choose — see `excerpt()` in `src/lib/prompts.ts`). A short generic list is only
   the fallback. Code-labelled sizes and places are renamed to the category's size / city dimension too
   (`alignAutoLabels()`), so everything lands on the same names the listing profile uses.

To cover more places or units, extend `PLACES`, `PLACE_ALIASES`, `SIZE_UNITS` or `UNIT_LABEL` in `data.ts`.

## Prompt

TASK: Label search terms. Each line is a term mined from the search keywords of ONE product category, with an example keyword containing it. For each term that is a filterable buyer qualifier, give its filter DIMENSION and the clean buyer-facing VALUE. Price words, places and sizes were already labelled by code.

DIMENSIONS come from the category, given in the user message:
- CATEGORY_DIMENSIONS: the category manager's ranked specs and the spec names sellers fill in listings, with common values.
- CATEGORY_CONTEXT_EXCERPT (if present): notes on how buyers choose.
Use a category dimension's name EXACTLY as written, so demand joins to listing fill rates. Prefer the listing spec name when the term matches one of its values ("puf" → "Insulation" if that spec lists PUF); when a ranked and a listing name mean the same thing, use the listing name.
Only if nothing fits, use a fallback: "Type / Application", "Material", "Size / Capacity" (size words without digits), "Feature", "Brand", "Condition / Buying mode" (new, used, rental, wholesale), "Seller type" (manufacturer, dealer, exporter). Invent a short new name only for a clearly recurring qualifier.

RULES
1. VALUE = the option label a buyer sees. Fix spelling ("puff" → "PUF"); expand abbreviations only when unambiguous here ("ms" → "MS (Mild Steel)"); synonyms and plurals get ONE identical value.
2. Label a two-word phrase only when it means more than its words ("mild steel", "second hand").
3. Skip terms with no filterable meaning: the category name or its misspellings, generic words (best, new, top, buy, online, latest, design, model, images, types, company), fragments, verbs.
4. One term → one dimension; use the example to disambiguate ("container" = Material in "container office cabin", Type in "shipping container"). Unsure → skip.

OUTPUT (only terms you label, copied exactly):
{"category_name": "e.g. Prefabricated Cabin",
 "dimensions": {"Material": {"PUF": ["puf", "puff"], "MS (Mild Steel)": ["ms", "mild steel"]}, "Usage/Application": {"Security Cabin": ["security"]}}}
