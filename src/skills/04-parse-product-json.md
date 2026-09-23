# Skill 04 · Parse product JSON / listing exports

Turns a raw product export — any JSON shape, CSV or XLSX — into flat records, then maps the messy
source field names onto canonical spec names so that fill rates can be measured per spec.

- **Layer:** code (flattening) + prompt (field-mapping stage — its own model call)
- **Used by:** stage 2 · listing field mapping
- **Code:** `src/lib/data.ts` → `flattenListing()`, `rawFieldSummary()`; `src/lib/prompts.ts` → `buildFieldMapUser()`

## What the code does

1. Finds the list of records wherever it lives (`products`, `items`, `data`, `listings`, … or the first array).
2. Flattens nested objects to dotted paths (`specs.material`).
3. Turns **name/value spec arrays** — e.g. `[{"name": "Material", "value": "MS"}]`, a common ISQ shape —
   into real keys (`Material: MS`).
4. Summarises every source field: fill %, three sample values. Only this summary goes to the model;
   the mapping is then applied by code to **all** listings (nothing is truncated or re-typed by the model).
5. Without a successful mapping, a heuristic profile is used (ids/URLs/images ignored, price fields detected by name).

## Prompt

TASK: Map the fields of a messy product-listing export (one category) onto a clean, canonical schema so fill rates can be measured per spec. You receive every source field with its fill rate and up to three sample values. For each source field choose ONE target:
- "@name" — the product title/name
- "@price" — the price or price range (numbers, possibly with ₹ and "/ Piece")
- "@unit" — the price unit (piece, sq ft, kg, set…) when it is a separate field
- "@category" — category / MCAT / group name
- "@ignore" — ids, URLs, images, descriptions, seller contact/company/address, dates, ratings, SEO text, and anything that is not a product attribute
- otherwise a canonical SPEC NAME in Title Case, as a buyer-facing filter would label it ("Material", "Size", "Usage/Application", "Brand", "Roof Type")

RULES
1. Different source fields that hold the same attribute MUST map to the identical spec name ("specs.material", "Material Type", "isq_material" → "Material").
2. Keep spec names short and generic; don't put units or the category name in them.
3. Decide by the field's name AND its samples. If you can't tell, use "@ignore".

OUTPUT:
{ "fields": [["source field exactly as given", "target"], ...] }
Include every source field.
