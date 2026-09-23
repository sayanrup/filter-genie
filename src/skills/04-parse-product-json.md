# Skill 04 · Parse product JSON / listing exports

Turns a raw product export — any JSON shape, CSV or XLSX — into flat records, then maps the messy
source field names onto canonical spec names so that fill rates can be measured per spec.

- **Layer:** code (flattening) + prompt (field-mapping stage — its own model call)
- **Used by:** step 2 · spec-name merging (skipped when fewer than 2 spec names)
- **Code:** `src/lib/data.ts` → `flattenListing()`, `rawFieldSummary()`; `src/lib/prompts.ts` → `buildFieldMapUser()`

## What the code does

1. Finds the list of records wherever it lives (`products`, `items`, `data`, `listings`, … or the first array).
2. Flattens nested objects to dotted paths (`specs.material`).
3. Turns **name/value spec arrays** — e.g. `[{"name": "Material", "value": "MS"}]`, a common ISQ shape —
   into real keys (`Material: MS`).
4. **Maps fields by rule, for free** (`heuristicFieldMap()`): ids, URLs, images, contacts, dates, ratings and
   long free text → ignored; name/title → `@name`; category/mcat → `@category`; price/mrp/rate → `@price`;
   unit/uom → `@unit`; everything else → a canonical spec name (`specs.isq_material_type` → `Material Type`).
   Fields with the same canonical name merge automatically.
5. Only when two or more spec names remain does the model get a call — and it sees just the spec names
   with fill % and three sample values, and returns only the merges/removals. The mapping is then applied
   by code to **all** listings.

## Prompt

TASK: Clean up spec names from a product-listing export (one category) so fill rates can be measured per spec. Each line is one spec name as found in the data, with its fill rate and up to three sample values.

Return only the changes needed:
- "merge": spec names that hold the SAME attribute, grouped under one short canonical Title Case name a buyer-facing filter would use ("Material Type", "Build Material" → "Material"; "Usage", "Application" → "Usage/Application"). Don't include units or the category name in names.
- "drop": spec names that are not product attributes (seller info, marketing text, stock, delivery, payment terms, ids).
Spec names you don't mention stay as they are. Decide by the name AND the samples; when unsure, leave a spec unchanged.

OUTPUT:
{"merge": {"Material": ["Material Type", "Build Material"]}, "drop": ["Delivery Time"]}
Copy spec names exactly as given. Use {} and [] when nothing needs changing.
