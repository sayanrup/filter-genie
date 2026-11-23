# Skill 04 · Parse product JSON / listing exports

Turns a raw product export — any JSON shape, CSV or XLSX — into flat records, then maps the messy
source field names onto canonical spec names so that fill rates can be measured per spec.

- **Layer:** code (flattening) + prompt (field-mapping stage — its own model call)
- **Used by:** step 2 · spec-name merging (skipped when fewer than 2 spec names)
- **Code:** `src/lib/data.ts` → `flattenListing()`, `rawFieldSummary()`; `src/lib/prompts.ts` → `buildFieldMapUser()`

## What the code does

0. **MCAT wrappers first:** an array of `{"input_mcat": {"id", "name"}, "primary_pmcat": {...}, "products": [...]}`
   is unwrapped into one row per product, tagged with the MCAT (`_group`, `_mcat_id`) and its primary PMCAT
   (`_pmcat`, `_pmcat_id`). Without this the wrappers themselves would be read as "listings".
1. Finds the list of records wherever it lives (`products`, `items`, `data`, `listings`, … or the first array).
   An object holding **several arrays of records** (e.g. one per category: `{"portable-cabins": [...],
   "office-cabins": [...]}`) is read in full — every group, each record tagged with `_group` (up to 5,000 rows per group). With two or
   more groups the app treats them as the MCATs of a subcategory and runs each on its own (skills 12–13).
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
   with fill % and three sample values, and returns only the merges/removals. The seller's city is not sent:
   code keeps it as Location evidence. The mapping is then applied by code to **all** listings
   (`applySpecMerges()`), with two checks: two names that one listing fills with different values are two
   attributes, so a merge never joins them ("Material: MS" and "Insulation Material: PUF" on one cabin); and
   the merged spec keeps one of the listings' own names (the model's pick if it is one, else the most-filled),
   never a new one, since later steps match ISQs by name. The model sees each spec's most common values with
   counts, so it can tell "100 kg/hr" from "500 L".
   Step 2 runs at the same time and names its dimensions after the specs as they were before the merge, so
   code renames its labels the same way afterwards (`specRenames()`: "Scooter Brand" → "Brand"): demand and
   fill rate then share one name.

## Prompt

TASK: Clean up spec names from a product-listing export (one category) so fill rates are counted per real spec. Each line: spec name | fill rate | sample values.

Return only the changes:
- "merge": names that are the SAME attribute written differently (spelling, plural, word order, a unit, or the product's or a generic word added: "Colour" / "Color", "Product Brand" / "Brand"), under ONE OF THOSE NAMES: the plainest (no unit, no product word), as listed. Never a new name: these are the sellers' spec names and are matched by name later. A name that narrows another to one part, side or kind is a DIFFERENT attribute and stays apart: "Inner Wall Material" is not "Material", "Eave Height" is not "Height", "Length" is not "Size", "No. of Gears" is not "Transmission". Their samples must be the same kind of value.
- "drop": only names that are not about the product itself: the seller or their business ("I Deal In", branches, service area), payment, delivery, stock, contact, ids. A product attribute stays even when it looks unimportant (Brand, Weight, Thickness, Roof Type, Capacity): later steps decide what matters.
Unmentioned names stay as they are. Judge by name AND samples; when unsure, leave it.

OUTPUT (names copied exactly; {} and [] when nothing changes):
{"merge": {"Material": ["Material", "Material Type", "Build Material"]}, "drop": ["Delivery Time"]}
