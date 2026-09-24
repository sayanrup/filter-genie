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
   common values, and a 1,500-character excerpt of the category context doc. A short generic list is only
   the fallback. Code-labelled sizes and places are renamed to the category's size / city dimension too
   (`alignAutoLabels()`), so everything lands on the same names the listing profile uses.

To cover more places or units, extend `PLACES`, `PLACE_ALIASES`, `SIZE_UNITS` or `UNIT_LABEL` in `data.ts`.

## Prompt

TASK: Label search terms. Each line is a term mined from the real search keywords of ONE product category, with one example keyword that contains it. For each term that is a filterable buyer qualifier, decide its filter DIMENSION and the clean buyer-facing VALUE it stands for. Price words, places and sizes were already labelled by code and are not in the list.

DIMENSIONS come from this category, not from a fixed list. The user message gives the category's own dimensions:
- CATEGORY_DIMENSIONS — the category manager's ranked specs and the spec names sellers fill in listings, with their common values.
- CATEGORY_CONTEXT_EXCERPT — research notes on how buyers choose in this category.
Label each term with the matching category dimension, using its name EXACTLY as written (prefer the listing spec name when a term matches one of its values, e.g. "puf" → "Insulation" if that spec lists PUF), so keyword demand can be joined to listing fill rates. Two dimensions with the same meaning (ranked "Application", listing "Usage/Application") → use the listing name.
Only when no category dimension fits, use a fallback: "Type / Application" (kind of product / what it's for), "Material", "Size / Capacity" (size words without digits), "Feature", "Brand", "Condition / Buying mode" (new, used, rental, wholesale), "Seller type" (manufacturer, dealer, exporter). Create a new short name only for a clearly recurring qualifier that fits nothing.

RULES
1. VALUE = the option label a buyer would see in a filter. Fix spelling ("puff" → "PUF"), expand an abbreviation only when unambiguous in this category ("ms" → "MS (Mild Steel)", "ss" → "Stainless Steel"), and give synonyms and plurals ONE identical value ("ms", "mild steel", "m.s" → "MS (Mild Steel)").
2. Label a two-word phrase only when it means something its words don't mean separately ("mild steel", "portable toilet", "second hand"); otherwise leave it out.
3. Leave out terms with no filterable meaning: the category's own name or its misspellings, generic words (best, new, good, top, online, buy, latest, design, model, images, types, company), fragments and verbs.
4. One term → one dimension. Use the example keyword to disambiguate ("container" is Material in "container office cabin" but Type in "shipping container"). If still unclear, leave it out.

OUTPUT — group terms under dimension → value; list only terms you label:
{"category_name": "short category name, e.g. Prefabricated Cabin",
 "dimensions": {"Material": {"PUF": ["puf", "puff"], "MS (Mild Steel)": ["ms", "mild steel"]}, "Usage/Application": {"Security Cabin": ["security"]}}}
Copy each term exactly as given.
