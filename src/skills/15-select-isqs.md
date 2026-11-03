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
   Span, or a **machine figure**: Capacity / Output / Throughput (a rate, a volume or a weight), Power /
   Wattage, Weight / Load, Volume — when at least 30% of its values are quantities of that kind. A name that
   names a choice is not a figure: `Power Source`, `Power Supply`, `Load Type` stay text (`quantity.ts`).
   - Units: lengths and areas (`ft`, `m`, `mm`, `sq ft`, `sq m`, `acre`…); weight `kg`, `g`, `ton`; volume `L`,
     `ml`; power `kW`, `HP`, `W`; rates `kg/hr`, `L/day`, `ton/hr`, `pcs/min`… (`per hour`, `/h`, `LPH`, `TPH`
     read the same). A rate's time base is part of its unit: `6500 kg/day` under `kg/hr`, or `2 HP` under
     `kW`, is another unit and is left out, never converted. `200 kg/8 hr` is not a quantity.
   - **Any other unit is a figure** (`125 cc`, `10 kVA`, `12 V`, `25 km/h`, `2000 mAh`): there is no list of these.
     An ISQ is a figure measurement, whatever its name, when its keyword dimension (the labelling model's values
     from step 2: it said `cc` numbers measure Engine Displacement) or else its own values are mostly numbers in
     one such unit, and it isn't a count ISQ. Its unit is written as the data writes it, preferring `kVA` / `V`
     to `Cc`. It pairs with the document ISQ whose values are in **the same unit**, whatever the names
     (`Engine Displacement` ↔ `Engine Capacity Class`). A document that lists more than 12 exact values gives
     the 12 the data holds first, then the rest spread over its list (`fewest()`).
   - One spelling: `20ft`, `20 Feet`, `20 FT.` → `20 ft`; `10*12 feet`, `10ft x 12ft` → `10 x 12 ft`;
     `1,000 Sq.Ft.` → `1000 sq ft`; `25 ft (7.5 m)` → `25 ft`; `100 Kg Per Hour` → `100 kg/hr`; ranges →
     `Up to 500 sq ft`, `500 - 1000 sq ft`, `Above 1000 sq ft`, `50 - 100 kg/hr`, `1000+ kg/hr` →
     `Above 1000 kg/hr`.
   - **Straight from the category document.** When the document has the same measurement, the ISQ's values
     **are the document's values**, as written there (one spelling only: `4x4x7 ft` → `4 x 4 x 7 ft`). Nothing
     of ours is added and nothing is invented; the data only says how strong each one is (Medium at the least,
     a range scored on the exact values inside it). The two are paired **by name, in code** — `Size` ↔
     `Cabin Size` / `Dimensions`, `Area` ↔ `Floor Area`, `Wall Thickness` ↔ `Wall Panel Thickness`,
     `Capacity` ↔ `Production Capacity` / `Output`, `Power` ↔ `Power Consumption`; Area and Size stand in for
     each other — so this never depends on the model (`measurementPairs()` in `category-doc.ts`). A machine
     figure takes the document's values only when at least one of its own values is a number of that kind
     (an area, length or size takes them whatever its own values look like). Only without such a document
     ISQ are our own values kept, cleaned as below.
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
   - a short form run into its number, and spellings of one word: `SS304` = `SS 304` = `Stainless Steel 304`;
     `Hr` = `Hour`; `Automated` = `Automatic`; `Auto` = `Automatic`; `Flavour` = `Flavor`
   - not values at all, and left out: `Other`, `All`, `Any`, `Etc`, `NA`, `Custom`, `As per requirement` (also
     written `Asper`), `Text` (`JUNK`); and a choice or span of options rather than one (`Large or Small`, `Both
Thick or Thin`: `VAGUE`). A trailing `etc` is cut (`Gray etc` → `Gray`).
   - **one way of writing**: each word capitalised the same way (`FULLY AUTOMATED` → `Fully Automated`,
     `Line type` → `Line Type`, `Stainless Steel(SS)` → `Stainless Steel (SS)`); short forms (`SS`, `PUF`, `HP`),
     joining words and units (`kg/hr`) stay as written.
   - of the spellings merged into one value, the one the data uses most is shown; on a tie, the standard
     one (`PUF`, not `Puff`).
3. **Confidence per value** — the usual rule (skill 09): High ≥ 20% of the keyword demand or of the listings
   that fill the spec, Medium ≥ 5%, else Low.
4. **Thin ISQ** — one High value or none (`THIN_HIGH`). Only then:
   - listing values the keywords missed, when the data makes them High or Medium;
   - then the category document's paired ISQ: one of our Medium / Low values that it lists goes **up one
     level** (Low → Medium, Medium → High) and takes the document's spelling — unless that spelling adds a
     figure ours doesn't have (`Electric` stays `Electric`, not the document's `0.5 kW Electric`); values of its
     own are added at the level the data gives them, **Medium** at the least.
   - At most **3** values are added (`MAX_ADDED`), and only up to **4** High / Medium values (`THIN_TARGET`).
5. **A text ISQ keeps only its own values** (`declutter()`):
   - **the MCAT itself is not an option**: `Dough Mixers` under the Dough Mixers MCAT's Mixer Type, `Milk
Processing Plant` under Milk Processing Plant and Machines, are left out;
   - values that **mix figures with words**: `Electric`, `Gas`, `1 HP`, `20 kW` under Power Source. A figure is
     a number with a unit (`1 HP`, `0.5 kW Electric`); counts and codes are not (`2 Seater`, `4 Trays`,
     `SS 304`, `G+1`, `3 Phase`);
   - a **count ISQ** with values that aren't counts (`Conical Rounder` among `24 Tray`, `40 Trays`, when counts
     are at least two thirds), or **whose name counts something its values don't** (`Tray Capacity` or
     `Capacity (Trays)` holding kg/hr or kg/day);
   - a **power or fuel source ISQ** (`Power Source`, `Fuel Type`, `Heating Source`) with values that aren't
     sources (`Liner`, `Milking Cluster` beside `Electric`).

   Then:
   - With the **live ISQs in input 4** (JSON, beside the document in input 3), the ISQ's values are the live
     ISQ's — same name, one name inside the other, or the one sharing the most values — **in the live order**
     (option priority 1 first; values that all begin with a number go smallest first), scored on the data
     and **Medium** at the least.
   - Without one, what doesn't belong is **left out**: the figures when words are most of the values ("left
     out 1 HP, 20 kW: power ratings, not Power Source values"; when figures are most, the ISQ is left as it
     is, with a warning); a count ISQ's other values ("left out Conical Rounder: not numbers of trays"); a
     count ISQ whose values are all figures has none left, so it isn't shown; a source ISQ's non-sources.
   - **A source the MCAT's name fixes**: under an `Electric Rotary Rack Oven` a power source without
     `Electric` (`Gas`, `Wood`) contradicts the MCAT and goes; with fewer than 2 values left the ISQ isn't
     shown — the name already says it (`Diesel Rotary Rack Oven` › `Electric`, `Diesel`).

   A **count ISQ** is one whose name counts something — `Number of Trays`, `No. of Decks`, `Tray Count`,
   `Capacity (Trays)` (brackets that name a thing, not a unit: `Capacity (kg/hr)` is a figure), or a thing a
   machine has a number of (`Tray Capacity`, `Trolley Capacity`: `COUNT_NOUN`; a container's capacity — tank,
   bowl, can — is a volume). It is never a weight or volume. Its values are compared **by number**: `10`,
   `10 Tray`, `10 trays` are one value, written `10 Trays` (`1 Tray` for one); British and American spellings are
   one (`Flavours` = `Flavors`); number words count (`Single Flavour` = `1 Flavor`; dual, double, twin = 2;
   triple = 3); a bare number counts when the name states the noun; a sum (`2+1 Flavour`) is kept as written.

6. **Shown values:** only High and Medium. With **3 or more High** values, the Medium ones are not shown.
   Values taken from a live ISQ keep the live order.
   **Numeric values are listed smallest first**: a measurement by its numbers (`4 x 4 ft`, `4 x 6 ft`,
   `10 x 10 ft`; a range by where it starts, `Up to …` first and `Above …` last), and text values that all
   begin with a number (`2 Seater`, `10 Seater`; `1 BHK`, `2 BHK`) by that number. Other values are listed best
   first (confidence, then fill rate, then keyword demand).

**ISQs of the MCAT**

7. **Never** Price / Budget / Cost or City / Location (removed in the check step), and never Tier 3.
8. **Tier 1** at any confidence; **Tier 2 only when High**.
9. Two ISQs for one attribute (`Size` and `Dimensions`) are **both** shown, not merged; a value shown under
   both stays under the one where it is stronger.
10. The **tier is the only test**: how many values an ISQ has doesn't decide whether it is shown. Its values are
    its High and Medium ones; an ISQ with none of those shows the values it has (Low).
11. **Every Tier 1 ISQ (High, Medium or Low) and every Tier 2 High ISQ is shown** — there is no cap on how many.
    When nothing needs the document, no pairing call is made (`isqsNeedingDoc()`).
12. The spec importance ranking (input 4) is used **last**: only to choose between two otherwise equal ISQs.
13. **An MCAT shows at least 3 ISQs** (`fillThin()`, `MIN_SHOWN_ISQS`). One that shows fewer — a few listings,
    where the model left everything in Tier 3 — is given more: the **live ISQs** (input 4) in their priority
    order, then the **category document's** ISQs, each with its own values (junk left out, at least 2), scored
    on the data and **Medium** at the least, a source the MCAT's name fixes still applied. A list that only
    repeats an ISQ already shown (2 of its values shown elsewhere) is skipped. Lists the model also made a
    Tier 1 or Tier 2 High ISQ for go first, and that ISQ is the one shown, with its listing evidence; a list the
    model put in Tier 3 (or Tier 2 below High) isn't used, the tier is the model's call. Otherwise a new Tier 1
    ISQ is added. Either way it is marked `added_from` (`live` / `doc`) and its note says why.

**Shown** (`isShown()`) means Tier 1 (High, Medium or Low) or Tier 2 High — nothing else (never Price or
Location). The "Shown" tag, the table's "N ISQs shown" count and the "Selected ISQs (.json)" download all use it,
so a result saved under earlier rules reads the same way: every Tier 1 / Tier 2 High ISQ is in the download.

**Measurements**: an exact value inside one of the ISQ's own ranges is that range (`1000 L` beside `500 - 1000 L`)
and is left out; the range already counts it.

**The check** (`checkSelection()`): every rule above is verified again on the finished result — tiers, price
and location, High / Medium only, the 3-High rule, 2 values per ISQ, one unit and kind per measurement, no
duplicate values inside an ISQ or across ISQs. Anything that doesn't hold is a run warning.

## What is stored

On each filter: `selected` and `select_note` (why not), `selected_values` (the values shown, in order),
`values` + `value_confidence` (the whole cleaned set, all levels; each value has `source`: `data`, `listing`
`doc` or `live` (from the live ISQ in input 4), and `lifted` when the document raised it), `doc_isq` (the document ISQ it used), `unit` (a
measurement's unit). The compact export ("Selected ISQs (.json)") holds only what is shown.

**AI-suggested values are gone.** The model is no longer asked for `suggested_values` (skill 10) and
`ai_values` is no longer shown: what the data lacks comes from the category document. The table hides the
ISQs that aren't shown until "View them" is clicked.

## Prompt

TASK: Pair this MCAT's ISQs with the ISQs of its category document, and pair their values.

The user message has ISQS (each with its values) and DOCUMENT_ISQS (each ISQ of the category document with its values).

RULES

1. ISQ: pair an ISQ with the ONE document ISQ that holds the same attribute, even under another name ("Material" = "Body Material"; "Size" = "Product Size"; "Usage" = "Application"). Judge by the names AND the values. Two ISQs never pair with the same document ISQ. A name that only shares a word is not the same attribute ("Material" ≠ "Material Thickness", "Height" ≠ "Width"). A measurement pairs only with the same measurement in the same unit: an area with an area, a length with that same length. No document ISQ holds it → leave the ISQ out.
2. VALUES: for each value of a paired ISQ, the document value that is the same thing in another spelling, abbreviation or with a generic word added ("SS" = "Stainless Steel", "Auto" = "Automatic", "3 Phase" = "Three Phase"). A different item, grade or number is not the same ("SS 304" ≠ "SS 316", "40 mm" ≠ "50 mm"), and neither is a value with a figure added ("Electric" ≠ "0.5 kW Electric"). Unsure → leave it out.
3. Copy every name and value exactly as written in the message.

OUTPUT ("values" maps the ISQ's value → the document's value; {} when none pair):
{"matches": [{"isq": "Material", "doc": "Body Material", "values": {"SS": "Stainless Steel"}}]}
