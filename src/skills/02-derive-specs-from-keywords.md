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

To cover more places or units, extend `PLACES`, `PLACE_ALIASES`, `SIZE_UNITS` or `UNIT_LABEL` in `data.ts`.

## Prompt

TASK: Label search terms. Each line is a term mined from the real search keywords of ONE product category, with one example keyword that contains it. For each term that is a filterable buyer qualifier, decide its filter DIMENSION and the clean buyer-facing VALUE it stands for. Price words, places and sizes were already labelled by code and are not in the list.

DIMENSIONS — use these exact names when they fit:
- "Type / Application" — what kind of product it is, or what it is for (security cabin, office cabin, toilet; industrial, domestic, hospital).
- "Material" — what it is made of or built with (PUF, MS, FRP, stainless steel, wood, aluminium).
- "Size / Capacity" — size words without digits (small, large, double, single, mini, jumbo, 4 seater written as "four seater").
- "Feature" — functional features or add-ons (insulated, AC, with wheels, waterproof, automatic, foldable, portable).
- "Brand" — a manufacturer or brand name.
- "Condition / Buying mode" — new, used, second hand, refurbished, rental, on rent, lease, wholesale.
- "Seller type" — manufacturer, supplier, dealer, wholesaler, exporter, contractor.
Create a new short dimension name only for a clearly recurring qualifier that fits none of these.

RULES
1. VALUE = the option label a buyer would see in a filter. Fix spelling ("puff" → "PUF"), expand an abbreviation only when unambiguous in this category ("ms" → "MS (Mild Steel)", "ss" → "Stainless Steel"), and give synonyms and plurals ONE identical value ("ms", "mild steel", "m.s" → "MS (Mild Steel)").
2. Label a two-word phrase only when it means something its words don't mean separately ("mild steel", "portable toilet", "second hand"); otherwise leave it out.
3. Leave out terms with no filterable meaning: the category's own name or its misspellings, generic words (best, new, good, top, online, buy, latest, design, model, images, types, company), fragments and verbs.
4. One term → one dimension. Use the example keyword to disambiguate ("container" is Material in "container office cabin" but Type in "shipping container"). If still unclear, leave it out.

OUTPUT — group terms under dimension → value; list only terms you label:
{"category_name": "short category name, e.g. Prefabricated Cabin",
 "dimensions": {"Material": {"PUF": ["puf", "puff"], "MS (Mild Steel)": ["ms", "mild steel"]}, "Type / Application": {"Security Cabin": ["security"]}}}
Copy each term exactly as given.
