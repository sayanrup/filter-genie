# Skill 02 · Derive specifications from search keywords

Finds which product attributes buyers type into search, and what values they use. The code mines
candidate *terms* from all keywords; the model labels each term with a filter **dimension** and a clean
buyer-facing **value**. The code then adds up demand per value (skill 03).

- **Layer:** code (term mining) + prompt (labelling stage — its own model call)
- **Used by:** step 1 · keyword term labelling (skipped only when there are no keywords)
- **Code:** `src/lib/data.ts` → `mineTerms()`, `unitGroups()`, `numberLabels()`; `src/lib/prompts.ts` →
  `buildTermLabelUser()`; `src/lib/filter-gen.ts` → `parseLabels()`, `parseUnits()`

## What the code does

Code keeps no word lists here (no units, price words or places): it finds and counts terms, and the model says
what they mean.

1. Merges simple plurals (`cabins` → `cabin`) when both forms occur.
2. Detects **core words**: words in ≥ 40% of keywords that belong to the category's own name (its MCAT and
   PMCAT). A frequent word that isn't in the name (`price`, a city) stays a term. When the name isn't known,
   any word in ≥ 40% of keywords is core.
3. Collects single words and recurring two-word phrases with, per source: keyword count, demand, action
   totals and the highest-demand example keyword.
4. **Numbers stay with the word after them**: `150 cc` → `150cc`, `10 x 12 ft` → `10x12ft`, `7 seater` →
   `7seater`, whatever the word is (not when it's a core word: `304 pipe` stays apart in a pipe category). These
   number terms are grouped by that word (`unitGroups()`), so the model sees one line per unit, not one per
   number.
5. Sends the top 150 other terms by share of demand as `term | example`, and the unit groups as
   `unit | numbers | example`. No demand figures are sent: the model doesn't need them to label.
6. **Dimensions are dynamic** (`dimensionCandidates()`): the model gets the category's own dimension names —
   the spec names parsed from the CM ranking, the listing spec names filled on ≥ 3% of listings with their
   common values, and a 1,200-character excerpt of the category context doc (the passages that mention those
   specs or how buyers choose — see `excerpt()` in `src/lib/prompts.ts`). A short generic list is only
   the fallback.
7. **Checks the answer**: a term label counts only for a term that was sent (`parseLabels()`). A unit counts only
   for a unit word that was sent, and may be respelled (`v` → `V`, `ltr` → `L`) or left out when the word isn't
   a unit (`2024 model` → `2024`), never swapped for another unit (`parseUnits()`). Code then labels every number
   of that unit: `150cc` → `Engine Displacement: 150 cc` (`numberLabels()`).

## Prompt

TASK: Label search terms. Each line of TERMS is a term mined from the search keywords of ONE product category, with an example keyword containing it. For each term that is a filterable buyer qualifier, give its filter DIMENSION and the clean buyer-facing VALUE. UNIT_TERMS lists the numbers buyers typed with a word after them, one line per word: say once per word what its numbers measure.

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
5. PRICE: a word asking about price or cost, in any language or spelling (price, rate, cost, cheap, quotation, kimat, sasta…) → dimension "Price", value "Price intent".
6. PLACES: a city, state or "near me" where the buyer wants a seller → dimension "Location" (or the seller-city spec's name if CATEGORY_DIMENSIONS has one), value = the place's usual name ("bangalore" → "Bengaluru", "near me" → "Near me"). The country alone ("india") → skip.
7. UNIT_TERMS: for each unit word, the DIMENSION its numbers measure (a category dimension when one fits, else a short name for the quantity) and the unit as buyers write it, respelled only, never converted ("v" → "V", "ltr" → "L"). A word that is not a unit (a model year, a grade, the product's own name) → "unit": "". "(none)" = sizes typed without a unit: give the dimension and "unit": "". Skip a unit whose numbers aren't a filterable quantity.

OUTPUT (only terms and units you label, copied exactly as listed):
{"category_name": "e.g. Prefabricated Cabin",
 "dimensions": {"Material": {"PUF": ["puf", "puff"], "MS (Mild Steel)": ["ms", "mild steel"]}, "Usage/Application": {"Security Cabin": ["security"]}},
 "units": {"<unit word as listed>": {"dimension": "<dimension>", "unit": "<unit as buyers write it>"}}}
