# Skill 04 · Parse product JSON / listing exports

Turns a raw product export — any JSON shape, CSV or XLSX — into flat records, then maps the messy
source field names onto canonical spec names so that fill rates can be measured per spec.

- **Layer:** code (flattening) + prompt (field-mapping stage — its own model call)
- **Used by:** step 2 · spec-name merging (skipped when fewer than 2 spec names)
- **Code:** `src/lib/data.ts` → `flattenListing()`, `rawFieldSummary()`; `src/lib/prompts.ts` → `buildFieldMapUser()`

## What the code does

1. Finds the list of records wherever it lives (`products`, `items`, `data`, `listings`, … or the first array).
   An object holding **several arrays of records** (e.g. one per category: `{"portable-cabins": [...],
   "office-cabins": [...]}`) is read in full — every group, each record tagged with `_group`.
2. Flattens nested objects to dotted paths (`specs.material`). Arrays of whole records inside a record
   (e.g. `more_prod` — other products of the same seller) are skipped so they don't skew fill rates.
3. Turns **name/value spec arrays** into real spec keys — `[{"name": "Material", "value": "MS"}]` and
   IndiaMART's `prd_isq: [{"MASTER_DESC": "Material", "OPTIONS_DESC": "PVC, Steel"}]` both become
   `Material: PVC, Steel`. Multi-select values are counted per option when profiling.
4. **Maps fields by rule, for free** (`heuristicFieldMap()`): ids, URLs, images, contacts, dates, ratings and
   long free text → ignored; name/title → `@name`; category/mcat → `@category`; price/mrp/rate → `@price`;
   unit/uom → `@unit`; everything else → a canonical spec name (`specs.isq_material_type` → `Material Type`).
   Fields with the same canonical name — ignoring case and punctuation — merge automatically.
   **When ≥ 30% of listings carry such a spec list, only those specs (plus the seller's city) are kept**;
   the remaining raw fields (ids, flags, ranks, seller metadata) are ignored.
5. Only when two or more spec names remain (filled on ≥ 2% of listings, top 60) does the model get a call — and it sees just the spec names
   with fill % and three sample values, and returns only the merges/removals. The mapping is then applied
   by code to **all** listings.

## Prompt

TASK: Clean up spec names from a product-listing export (one category) so fill rates are counted per real spec. Each line: spec name | fill rate | sample values.

Return only the changes:
- "merge": names holding the SAME attribute, under one short Title Case buyer-facing name ("Material Type", "Build Material" → "Material"). No units or category name in names.
- "drop": names that are not product attributes (seller info, marketing text, stock, delivery, payment terms, ids).
Unmentioned names stay as they are. Judge by name AND samples; when unsure, leave it.

OUTPUT (names copied exactly; {} and [] when nothing changes):
{"merge": {"Material": ["Material Type", "Build Material"]}, "drop": ["Delivery Time"]}
