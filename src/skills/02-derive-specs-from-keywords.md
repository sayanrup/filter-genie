# Skill 02 · Derive specifications from search keywords

Finds which product attributes buyers type into search, and what values they use. The code mines
candidate *terms* from all keywords; the model labels each term with a filter **dimension** and a clean
buyer-facing **value**. The code then adds up demand per value (skill 03).

- **Layer:** code (term mining) + prompt (labelling stage — its own model call)
- **Used by:** stage 1 · keyword term labelling
- **Code:** `src/lib/data.ts` → `mineTerms()`; `src/lib/prompts.ts` → `buildTermLabelUser()`

## What the code does

1. Merges simple plurals (`cabins` → `cabin`) when both forms occur.
2. Detects **core words** — words in ≥ 40% of keywords (the category name itself) — and excludes them.
3. Collects unigrams and two-word phrases (both words non-core, non-stopword) with, per source:
   keyword count, demand and action totals, and the highest-demand example keyword.
4. Flags likely sizes (`[size?]`), price intent (`[price?]`) and places (`[location?]`) with patterns.
5. Keeps the top 250 terms by share of demand (plus every flagged term) and sends them for labelling.

## Prompt

TASK: Label search terms. You receive TERMS mined from the real search keywords of ONE product category. Each row shows how many keywords contain the term, the demand those keywords carry, and one example keyword. Decide, for each term, whether it is a filterable buyer qualifier — and if so, which filter DIMENSION it belongs to and the clean buyer-facing VALUE it stands for. You never add up numbers; code totals demand from your labels. Accurate, consistent labels are the whole job.

DIMENSIONS — use these exact names when they fit:
- "Type / Application" — what kind of product it is, or what it is for (security cabin, office cabin, toilet; industrial, domestic, hospital, school).
- "Material" — what it is made of or built with (PUF, MS, FRP, stainless steel, wood, aluminium, container-based).
- "Size / Capacity" — dimensions, area, volume, load, seats, power rating (20 ft, 10 x 10, 1000 L, 2 ton, 4 seater, 5 HP).
- "Price" — price, cost, rate, cheap, budget, quotation, ₹/rs intent. Map EVERY such term to the single value "Price intent".
- "Location" — a city, state or region, or "near me". Value = the place name in title case; merge spelling variants ("bangalore"/"bengaluru" → "Bengaluru", "gurgaon"/"gurugram" → "Gurugram"). Map "near-me"/"nearby"/"local" to "Near me".
- "Feature" — functional features or add-ons (insulated, AC, with wheels, waterproof, automatic, foldable, with toilet).
- "Brand" — a manufacturer or brand name.
- "Condition / Buying mode" — new, used, second hand, refurbished, on rent, rental, lease.
- "Seller type" — manufacturer, supplier, dealer, wholesaler, exporter, contractor, company.
Create a new short dimension name ONLY for a clearly recurring qualifier that fits none of the above.

LABELLING RULES
1. VALUE is the option label as a buyer would see it in a filter. Fix spelling ("puff" → "PUF"), expand an abbreviation only when unambiguous in this category ("ms" → "MS (Mild Steel)", "ss" → "Stainless Steel"), and make synonyms and plurals share ONE identical value string ("ms", "mild steel", "m.s" → exactly "MS (Mild Steel)").
2. Size values: normalise units and formatting ("20ft" → "20 ft"; "10x10" → "10 x 10 ft" only when the example shows the unit is feet, else "10 x 10"; "1000l" → "1000 L"). Keep one value per distinct size — do not invent ranges.
3. Two-word terms: label the phrase only when it means something its words don't mean separately ("mild steel", "portable toilet", "second hand"). Otherwise omit it — its single words are labelled on their own.
4. OMIT terms with no filterable meaning: words naming the category itself, generic words (best, new, good, top, online, buy, india, latest, design, model, images, types), misspellings of the category name, fragments, and verbs.
5. One term → one dimension. Use the example keyword to disambiguate ("container" is Material in "container office cabin" but Type in "shipping container"). If still unclear, omit it.
6. A hint like [size?], [price?] or [location?] means a pattern matcher flagged the term. It is usually right; confirm it.

OUTPUT:
{
  "category_name": "short category name, e.g. Prefabricated Cabin",
  "labels": [["term exactly as given", "Dimension", "Value"], ...]
}
Include every term that carries a filterable signal (labelling 100+ terms is normal). Leave omitted terms out of "labels".
