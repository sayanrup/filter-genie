# Skill 15 · Select the ISQs and their values

Decides which ISQs, and which of their values, are finally shown. Everything is code except one small call
that pairs ISQs with the category document.

- **Layer:** code (all the rules and the check) + prompt (pair names with the category document)
- **Used by:** the "Select ISQs" step, after the check step. At most one model call per MCAT, and only when
  the MCAT has a category document and an ISQ that needs it (a measurement, or a thin one).
- **Code:** `src/lib/select-isqs.ts` → `selectIsqs()`, `checkSelection()`, `isqsNeedingDoc()`;
  `src/lib/quantity.ts` (measurements); `src/lib/category-doc.ts` (the document and the pairs);
  `src/lib/prompts.ts` → `buildDocMatchUser()`; `src/lib/filter-gen.ts` → the "select" step.

## The category document

Per MCAT, the **"1. Buyer Attracting Seller Specs"** table of its Seller & Buyer Spec Audit: the seller spec
questions and the options under each. It comes in through **input 3**:

- the JSON saved by `scripts/fetch-mcat-context.ts` (`saved-results/mcat-context.json`: one entry per MCAT
  with `buyer_attracting_seller_specs`). The MCAT is found by `mcat_id`, then by name. This JSON is **not**
  sent to the model as context; it is used here only.
- or the audit's markdown ("Load spec audit"), which the model still reads as context, as before.

It is used for two things and nothing else: **thin ISQs** and **measurements**. It never decides which ISQs
exist, their tier or their confidence.

## The rules, in the order they run

**Values of each ISQ**

1. **Measurements** — an ISQ named Area, Size, Dimensions, Length, Width, Height, Thickness, Diameter, Depth or
   Span, when at least 30% of its values are quantities.
   - One spelling: `20ft`, `20 Feet`, `20 FT.` → `20 ft`; `10*12 feet`, `10ft x 12ft` → `10 x 12 ft`;
     `1,000 Sq.Ft.` → `1000 sq ft`; `25 ft (7.5 m)` → `25 ft`; ranges → `Up to 500 sq ft`,
     `500 - 1000 sq ft`, `Above 1000 sq ft`.
   - **Straight from the category document.** When the document has the same measurement, the ISQ's values
     **are the document's values**, as written there (one spelling only: `4x4x7 ft` → `4 x 4 x 7 ft`). Nothing
     of ours is added and nothing is invented; the data only says how strong each one is (Medium at the least,
     a range scored on the exact values inside it). The two are paired **by name, in code** — `Size` ↔
     `Cabin Size` / `Dimensions`, `Area` ↔ `Floor Area`, `Wall Thickness` ↔ `Wall Panel Thickness`; Area and
     Size stand in for each other — so this never depends on the model (`measurementPairs()` in
     `category-doc.ts`). Only without such a document ISQ are our own values kept, cleaned as below.
   - One **shape** per ISQ: a unit, and **how many numbers a value has**. A Length, Width, Height, Thickness,
     Diameter or Depth is always **one** number. An Area or a Size is one (`500 sq ft`), two (`20 x 10 ft`) or
     three (`20 x 10 x 8 ft`). **The category document's ISQ decides both** when one is paired; otherwise the
     commonest in the data. A value with no unit takes the ISQ's; a 3-number size keeps its first two when the
     ISQ's sizes are length x width; a whole size under Length, Width or Height gives that one number
     (`20 x 10 ft` under Length → `20 ft`, under Width → `10 ft`).
   - Left out, and named in the step's working: text (`as per requirement`), another unit (never converted),
     another kind (`300 x 250 ft` under Area, `20 ft` under a length x width Size), `Other`.
   - Without a document ISQ, a warning says so when our own values are poor: fewer than **3** good ones, or
     **exact numbers mixed with ranges** (`600 sq ft` beside `500 - 1000 sq ft`).
2. **No duplicates.** Values are compared by meaning, and their numbers are added before the confidence is
   worked out, over every spelling in the keywords and the listings:
   - spelling: `Steel` / `Steels`, `Greenhouse` / `Green House`, `Aluminum` / `Aluminium`
   - short and full form: `MS` / `Mild Steel` / `MS (Mild Steel)`, `GI`, `SS`, `FRP`, `PUF`, `ACP`, `EPS`,
     `HDPE`, `PEB`, `LGSF` (`SHORT_FORMS`)
   - generic beside specific. With **one** specific (`Office` beside `Portable Office`) the two are one
     value: the stronger spelling stays (the specific one on a tie) and their numbers are added. With
     **several** (`Wood` beside `Pine Wood` and `Teak Wood`) the specifics are the real options, so the
     generic goes. A combination (`MS With GI`, `FRP And PVC`) is not a kind of its parts, so both stay.
   - not values at all, and left out: `Other`, `All`, `Any`, `Etc`, `NA`, `Custom`, `As per requirement`
     (`JUNK`); a trailing `etc` is cut (`Gray etc` → `Gray`).
   - of the spellings merged into one value, the one the data uses most is shown; on a tie, the standard
     one (`PUF`, not `Puff`).
3. **Confidence per value** — the usual rule (skill 09): High ≥ 20% of the keyword demand or of the listings
   that fill the spec, Medium ≥ 5%, else Low.
4. **Thin ISQ** — one High value or none (`THIN_HIGH`). Only then:
   - listing values the keywords missed, when the data makes them High or Medium;
   - then the category document's paired ISQ: one of our Medium / Low values that it lists goes **up one
     level** (Low → Medium, Medium → High) and takes the document's spelling; values of its own are added at
     the level the data gives them, **Medium** at the least.
   - At most **3** values are added (`MAX_ADDED`), and only up to **4** High / Medium values (`THIN_TARGET`).
5. **Shown values:** only High and Medium. With **4 or more High** values, the Medium ones are not shown.
   **Numeric values are listed smallest first**: a measurement by its numbers (`4 x 4 ft`, `4 x 6 ft`,
   `10 x 10 ft`; a range by where it starts, `Up to …` first and `Above …` last), and text values that all
   begin with a number (`2 Seater`, `10 Seater`; `1 BHK`, `2 BHK`) by that number. Other values are listed best
   first (confidence, then fill rate, then keyword demand).

**ISQs of the MCAT**

6. **Never** Price / Budget / Cost or City / Location (removed in the check step), and never Tier 3.
7. **Tier 1** at any confidence; **Tier 2 only when High**.
8. Two ISQs for one attribute are one (`Type/Application` + `Usage/Application`, `Size` + `Dimensions`): the
   better one keeps the other's values. A value shown under two ISQs stays under the one where it is stronger.
9. An ISQ needs **2** shown values.
10. With **3 or more Tier 1 High / Medium ISQs**, Tier 1 Low and Tier 2 ISQs are not shown. This is also
    checked **early** (`isqsNeedingDoc()`): when 3 such ISQs already have their values, the Tier 1 Low and
    Tier 2 ones aren't sent to the pairing call, and when nothing needs the document no call is made.
11. The spec importance ranking (input 4) is used **last**: only to choose between two otherwise equal ISQs.

**The check** (`checkSelection()`): every rule above is verified again on the finished result — tiers, price
and location, High / Medium only, the 4-High rule, 2 values per ISQ, one unit and kind per measurement, no
duplicate values inside an ISQ or across ISQs. Anything that doesn't hold is a run warning.

## What is stored

On each filter: `selected` and `select_note` (why not), `selected_values` (the values shown, in order),
`values` + `value_confidence` (the whole cleaned set, all levels; each value has `source`: `data`, `listing`
or `doc`, and `lifted` when the document raised it), `doc_isq` (the document ISQ it used), `unit` (a
measurement's unit). The compact export ("Selected ISQs (.json)") holds only what is shown.

**AI-suggested values are gone.** The model is no longer asked for `suggested_values` (skill 10) and
`ai_values` is no longer shown: what the data lacks comes from the category document. The table hides the
ISQs that aren't shown until "View them" is clicked.

## Prompt

TASK: Pair this MCAT's ISQs with the ISQs of its category document, and pair their values.

The user message has ISQS (each with its values) and DOCUMENT_ISQS (each ISQ of the category document with its values).

RULES
1. ISQ: pair an ISQ with the ONE document ISQ that holds the same attribute, even under another name ("Material" = "Wall Panel Material"; "Size" = "Cabin Size"; "Usage" = "Application"). Judge by the names AND the values. Two ISQs never pair with the same document ISQ. A name that only shares a word is not the same attribute ("Area" ≠ "Clear Span Width", "Wall Panel" ≠ "Wall Panel Thickness", "Height" ≠ "Width"). A measurement pairs only with the same measurement: an area with an area, a length with that same length. No document ISQ holds it → leave the ISQ out.
2. VALUES: for each value of a paired ISQ, the document value that is the same thing in another spelling, abbreviation or with a generic word added ("PUF" = "PUF Panel", "MS" = "Mild Steel", "Thermocol" = "EPS (Thermocol)"). A different item, grade or number is not the same ("EPS" ≠ "PUF", "40 mm" ≠ "50 mm", "10 x 10 ft" ≠ "20 x 10 ft"). Unsure → leave it out.
3. Copy every name and value exactly as written in the message.

OUTPUT ("values" maps the ISQ's value → the document's value; {} when none pair):
{"matches": [{"isq": "Material", "doc": "Wall Panel Material", "values": {"PUF": "PUF Panel"}}]}
