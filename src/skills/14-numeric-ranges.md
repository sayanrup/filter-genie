# Skill 14 · Numeric ranges (lower and upper bounds for ISQ values)

Some ISQ values are quantities: a price band, a size, a capacity, a thickness. As plain text they can only
be matched as text. This step gives each such value a **lower and an upper bound**, so a search can match
listings by number ("100–200 sq ft") instead of by the option's label. Values that are sizes written as
several numbers ("10x12 ft", "40ft x 10ft x 8.5ft") become a filter with **one slider per axis** (length,
width, height), each with a lower and upper limit and a unit.

- **Layer:** prompt + code check
- **Used by:** the ranges step, one model call per run, after the check step (it needs the final values)
- **Code:** `src/lib/ranges.ts` → `applyRanges()`, `checkBounds()`, `checkDimensionOption()`;
  `src/lib/prompts.ts` → `buildRangesUser()`; `src/lib/filter-gen.ts` → the "ranges" step. The result is
  stored on each filter as `ranges` (`value`, `min`, `max`, `unit`) or, for sizes, `dimensions` (`unit`,
  `axes`, `rotation_ok`, `note`, `options`), so a saved result keeps it.

## What goes in

Every final filter that has at least one value with a digit in it (at most 6 filters, see skill 08): its
name, tier, **all** its option values exactly as shown, and the evidence behind it: the linked listing
spec's fill %, distinct values and most common values with counts; for Price, the priced-listing stats
(min · 25th pct · median · 75th pct · max, unit). The stats are context for deciding what kind of filter it
is and in what unit. They are never a source of bounds.

## What comes out, and what code keeps

`{"ranges": [ … ]}` with one item per numeric filter. Code keeps a bound only when **the number is in the
option's own text** (thousands commas removed, Lakh / Crore / K applied), so a number can never be invented:

**One quantity per value** (price, area, capacity, thickness, time):
`{"filter", "unit", "options": [{"value", "min", "max"}]}`

- `value` must be one of the filter's options, letter for letter.
- `min` / `max` are numbers or null (an open end). Not both null, `min` ≤ `max`.
- Open-end words ("Up to", "Under", "Above", "50,000+", "≥") allow one side null. A closed value needs both:
  one number means min = max; two numbers mean lowest and highest.
- Standards, grades and zones ("IS 2062 E450", "Zone III") never get bounds.
- A filter keeps its ranges only when at least two of its options pass.

**Sizes written as several numbers** (`10x12 ft`): `{"filter", "kind": "dimensions", "unit", "axes", "rotation_ok",
"note", "options": [{"value", "parts": [{"axis", "number", "unit"}]}]}`

- The model **names the axes and judges the search behaviour**; code does the arithmetic. Each part is the
  number exactly as written plus the unit as written for it. Code checks the number against the value's text,
  converts every part to the filter's unit with a fixed table (ft, m, mm, cm, in), and rounds to 4 places.
- The slider ends of an axis are the smallest and largest size among the filter's own options (this
  MCAT's listings), never a made-up 0 or maximum.
- Code also works out the floor area (first two axes) as an extra line; it is not asked of the model.
- A filter keeps its sizes only when at least two options pass and at least two axes have data.

**Exact values** (`2.5 m`, `4 Meter`, `4.5 m`, `5 m`): `{"filter", "kind": "buckets", "unit", "edges"}`

- The model only chooses the edges, from the numbers of the filter's own values. Code builds the buckets
  ("Less than 2.5 m", "2.5 to 4 m", "4 to 5 m", "More than 5 m"; each range holds its lower edge, the top one
  also its upper edge), checks every edge against the values, and replaces the exact values with them (the old
  ones are kept in `exact_values`). With bad or missing edges, code picks them from the listings' own spread.
- A filter that already has ranges among its values ("Up to 5,000", "5,001 - 10,000", "3000 sq ft") needs no
  edges: its exact values are folded into the range that holds them, and near-duplicate spellings
  ("10000 sq.ft" / "10000 sq ft") disappear in the process.

**Never left unprocessed.** If the model skips a numeric filter, or its call fails, code reads the filter itself
(`inferRanges`): at least two of its values, and 60% of them, are one plain quantity in one measurable unit
(lengths, areas, weights, volumes, power, time, ₹). A value with no unit takes the filter's unit. Counts of things
("6 seater", "2 Doors", "4 cars"), grades, standards, sizes and unknown units are never read this way.

**Mixed units, brackets, open ends.** Code converts values of the same kind (ft/m/in/cm/mm, sq ft/sq m, kg/g/ton,
litre/ml) into the filter's commonest unit by fixed factors, and reads "25 ft (7.5 m)" as 25 ft. Ranges that stop at
a closed top or start at a closed bottom get a "More than …" / "Less than …" end. Two different exact numbers are
enough for buckets. Where code can read more of a filter than the model's answer covers, code's reading is used.

**Sizes win.** A filter with two or more size values ("10 x 10", "20 x 10 x 8") is one size filter, even if the model
(or a first reading) gave its plain lengths ranges; its single lengths ("20 ft") count as Length. If the model
returns no sizes, code builds them from the values (axes in written order, ft when no unit is written).

**Fill rate.** Every range gets `listings` and `fill_pct`: the listings whose value is the option's own text, or
one number inside the range (in the same unit), as a share of all the listings profiled.

Options that fail a check stay plain labels, and the run's warnings list them.

## Reference (why it is built this way)

Research notes behind the rules, from faceted-search and B2B-catalogue practice:

- **Bounds are the contract, labels are for people.** A search backend takes `from` / `to` per bucket
  (range aggregations, range queries); an option text can't be queried by number.
- **Don't turn discrete values into ranges.** "10 MP" is hard to find inside "9.9–11.9 MP"; a short list of
  exact values (door counts, grades) stays as exact options. Only continuous quantities get ranges. A size
  filter keeps its standard sizes as options *and* gets sliders for the custom case.
- **Let buyers set their own range.** Presets are shortcuts; a min and a max box beside each slider is what
  Baymard lists as the usual missing piece. Sliders also need a unit label, a count of results, and (when
  sizes span orders of magnitude) a non-linear scale.
- **Separate axes beat one "size".** Baymard recommends separate width / height / depth filters where a
  product must fit a space, each labelled ("Width: 90 cm"), because a bare "90 cm" is ambiguous.
- **Fit is not the same as range.** For a space, the upper limit matters ("at most"); for capacity, the lower
  one ("at least"). Two-handle sliders overconstrain, so each axis says how it is read. Length and width of a
  footprint can be swapped (`rotation_ok`): a 10x20 cabin fits a 20x10 plot.
- **Keep one unit per attribute** and never mix metric and imperial in one slider; keep the raw text next to
  the parsed numbers (the option's label stays as it is).
- **Open ends are real.** "Up to X" and "Above X" are one-sided ranges, not ranges with a made-up zero or
  infinity.
- **Overlap is a search-time decision.** When a listing itself is a span ("10–20 kg"), whether it matches a
  buyer's range by overlap, by containing it, or by sitting inside it is a rule of the search, not of this
  step; the bounds here are enough for any of them.

Known limits: feet-and-inches ("4'6\"") and values with several sizes aren't read; "L x W x H" is not turned
into an area for the one-quantity filters; a one-quantity filter that mixes units keeps only its most
common unit. The ranges a filter already has are never re-cut; only exact values are grouped.

## Prompt

NUMERIC RANGES: the filters in the user message are final. Each lists its option values (its ISQ values) exactly as shown to buyers. For every filter whose options are MEASURED QUANTITIES — a price, size, area, length, width, height, thickness, capacity, weight, power, volume, speed, time or any other number with a unit — give each of its values a lower and an upper bound, so the search can match listings by number. Leave every other filter out of your answer.

DECIDE FOR EACH FILTER, IN THIS ORDER (the first that fits):
 A. SIZE FILTER: at least two of its values are written as two or three numbers joined by x ("10 x 10", "20 x 10 x 8", "4x4x7 ft"). Use kind "dimensions" (rules 7–9). The other values in it do not stop this: single lengths with a unit ("20 ft") count as Length; words, "Other" and counts ("3 seater") are simply left out of "options".
 B. EXACT NUMBERS: most options are one number each ("2.5 m", "4 Meter", "14 Feet", "500 kg") and there are at least two different numbers. Use kind "buckets" with edges (rule 10).
 C. RANGES: the options are already ranges or open ends ("5,001 - 10,000 sq ft", "Up to 5,000", "₹750 – ₹962"). List each with min and max (rules 1–6).
 D. Anything else: leave the filter out.
Never skip a whole filter because some of its values do not fit: handle the ones that do and leave the rest out of "options".

RULES — ONE QUANTITY PER VALUE
1. NUMERIC OR NOT. A filter is numeric only when most of its values are a number, or a span of numbers, with a unit, and buyers compare it as "more or less". Skip: materials, types, brands, places; standards, grades and codes (IS 2062 E450, ISO 9001:2015, Zone III, B1); counts of things: seats, persons, cars, doors, rooms, floors, pieces ("6 seater", "10 seater", "2 Doors", "4 cars"). A count stays a list of exact options however many different numbers it has: never give it ranges or edges. Also skip yes/no values and "Other".
2. BOUNDS COME FROM THE VALUE'S OWN TEXT, in the unit it is written in. Never convert units, never round, never invent a number, never take a bound from the stats. "min" is the lower bound, "max" the upper; null means open.
   - "5,001 - 10,000 sq ft" → min 5001, max 10000
   - "Up to 15 meters", "Under 500 kg", "Below ₹50,000" → min null, max 15 / 500 / 50000
   - "Above 60 meters", "More than 50,000", "50,000+" → min 60 / 50000 / 50000, max null
   - one number, "80 mm" or "1000 litres" → min 80 and max 80 (an exact value)
   - Indian words: 1.5 Lakh = 150000, 2 Crore = 20000000, 50K = 50000. Drop thousands commas (5,000 and 1,50,000 are single numbers). "₹50,000 – ₹1.5 Lakh/piece" → min 50000, max 150000, unit "₹/piece".
3. SKIP A VALUE (leave it out of "options") when it mixes a name with a code or grade (PUF 75mm is fine, IS 4759:2019 is not) or has no number.
4. ONE UNIT PER FILTER. "unit" is the unit the options are written in ("sq ft", "meters", "₹", "₹/piece", "days"). If a filter mixes units of the same kind (ft and m, kg and g, sq ft and sq m), name and return only the options in the most common unit: code reads and converts the others itself. A bracket that restates a value in another unit, "25 ft (7.5 m)", is ONE quantity: use the first number and ignore the bracket.
5. OPEN ENDS ONLY WHERE THE VALUE SAYS SO. Do not add "Up to" or "Above" yourself and do not fill a missing bound with 0 or a large number. Do not merge, split or reorder the options you list: one entry per option, in the order given. (Grouping exact values into ranges is rule 10.)
6. "filter" and "value" must match the names in the message letter for letter.

RULES — SIZES WRITTEN AS SEVERAL NUMBERS (10x12 ft, 40ft x 10ft x 8.5ft, 30m x 60m x 8m, 4' x 4' x 7')
7. A filter that matches decision A is {"kind": "dimensions"}. Give:
   - "axes": the axes in the order the numbers are written, 2 or 3 of them. Two numbers are Length and Width, three are Length, Width and Height, unless the filter's name or the values say otherwise (for example "Diameter x Height"). If some values have two numbers and some three, list all three; a value with fewer numbers simply has no later axis. Each axis is {"name", "match"}: "match" is "at_most" when the buyer's limit is a space the product must fit (the length, width or height of a cabin, shelter, room or plot), "at_least" when bigger is better (clear span, usable height, capacity), "between" otherwise.
   - "rotation_ok": true when length and width are interchangeable for a buyer (a footprint: cabin, shelter, room, plot), false when the order matters (diameter x height, thickness x width).
   - "unit": the unit the most values write, one of ft, m, mm, cm, in. Every size in the filter will be shown in it. If NO value writes a unit ("10 x 10", "4 x 8"), choose the unit buyers use for this kind of product: ft for cabins, shelters, rooms, houses and plots; m for halls, sheds and industrial buildings; mm or cm for parts and sheets.
   - "note": one short sentence naming every assumption you made: the axis order, a unit you had to assume, the values that have no height. Never leave it empty when you assumed something.
8. Include EVERY size value in "options", even when its unit is missing. A single number with a length unit ("20 ft", "5 ft", "6 m") is an option with one part, on the Length axis. Each option is {"value", "parts"}: one part per number, in the order written, {"axis", "number", "unit"}. "number" is the number exactly as written (8.5, not 8 1/2 or 9); "unit" is the unit written for that part. A unit written only once at the end ("10x12 ft") belongs to every part. If no unit is written anywhere, use the filter's unit (code marks the value "unit assumed"). Never convert: code converts, including "30m x 60m x 8m" into ft.
9. SKIP a size value (leave it out of "options") when it holds a range or an open end ("10-12 x 20 ft", "Up to 20x20"), feet-and-inches (4'6"), more than three numbers, two sizes at once ("10x10 / 12x12"), or words instead of numbers ("Customised", "As per requirement"), and a single number with no length unit ("3 seater"). Never guess a number.

RULES — EXACT VALUES BECOME RANGES
10. When most of a numeric filter's options are exact single numbers (min = max: "2.5 m", "4 Meter", "4.5 m", "5 m") and there are at least two different numbers, buyers should see ranges, not a pile of exact values. Return {"filter", "kind": "buckets", "unit", "edges": [...]} instead of listing the options: 2 to 5 edges in ascending order, each one exactly a number that appears in one of the filter's options (written as the option writes it: "13" for "13 Feet"). With only two different numbers, both are the edges. Code builds the buckets from them: "Less than e1", "e1 to e2", …, "More than e(last)", with the lower edge inside each range and the top edge inside the last "to" range. Choose the edges with the listing counts in the message: every bucket should hold a useful share of the listings, no bucket nearly all of them, and prefer round numbers or standard sizes that are among the values. (A filter that already has ranges among its options, "Up to 5,000", "5,001 - 10,000", needs no edges: code folds its exact values into the ranges and adds "More than 25,000" / "Less than …" ends where the ranges stop. Do not add those yourself.)

OUTPUT (JSON only; the kinds can all appear):
{"ranges": [
 {"filter": "<filter name>", "unit": "<unit>", "options": [{"value": "<option text>", "min": <number|null>, "max": <number|null>}]},
 {"filter": "<filter name>", "kind": "buckets", "unit": "<unit>", "edges": [<number>, <number>, …]},
 {"filter": "<filter name>", "kind": "dimensions", "unit": "ft", "axes": [{"name": "Length", "match": "at_most"}, {"name": "Width", "match": "at_most"}, {"name": "Height", "match": "at_most"}], "rotation_ok": true, "note": "<assumptions>", "options": [{"value": "<option text>", "parts": [{"axis": "Length", "number": <number>, "unit": "<unit>"}]}]}
]}
If no filter is numeric: {"ranges": []}

EXAMPLE 1 — filter "Building Size" with options "Up to 5,000 sq ft", "5,001 - 10,000 sq ft", "10,001 - 25,000 sq ft", "Above 25,000 sq ft"; filter "Roof Cladding" with options "Sandwich Panel", "PUF Panel":
{"ranges": [{"filter": "Building Size", "unit": "sq ft", "options": [{"value": "Up to 5,000 sq ft", "min": null, "max": 5000}, {"value": "5,001 - 10,000 sq ft", "min": 5001, "max": 10000}, {"value": "10,001 - 25,000 sq ft", "min": 10001, "max": 25000}, {"value": "Above 25,000 sq ft", "min": 25000, "max": null}]}]}
(Roof Cladding is not a quantity, so it is left out.)

EXAMPLE 2 — filter "Cabin Size" with options "10x12 ft", "8 x 8 x 8.5 ft", "30m x 60m x 8m", "Customised":
{"ranges": [{"filter": "Cabin Size", "kind": "dimensions", "unit": "ft", "axes": [{"name": "Length", "match": "at_most"}, {"name": "Width", "match": "at_most"}, {"name": "Height", "match": "at_most"}], "rotation_ok": true, "note": "Axis order assumed length x width x height; 10x12 ft has no height; 30m x 60m x 8m is in metres and converted to ft.", "options": [{"value": "10x12 ft", "parts": [{"axis": "Length", "number": 10, "unit": "ft"}, {"axis": "Width", "number": 12, "unit": "ft"}]}, {"value": "8 x 8 x 8.5 ft", "parts": [{"axis": "Length", "number": 8, "unit": "ft"}, {"axis": "Width", "number": 8, "unit": "ft"}, {"axis": "Height", "number": 8.5, "unit": "ft"}]}, {"value": "30m x 60m x 8m", "parts": [{"axis": "Length", "number": 30, "unit": "m"}, {"axis": "Width", "number": 60, "unit": "m"}, {"axis": "Height", "number": 8, "unit": "m"}]}]}]}
("Customised" has no numbers, so it is left out.)

EXAMPLE 3 — filter "Length" with options "2.5 m", "4 Meter", "4.5 m", "5 m", "6 m", "8 m" (listing counts: 2.5 m (3), 4 Meter (9), 4.5 m (4), 5 m (11), 6 m (2), 8 m (1)):
{"ranges": [{"filter": "Length", "kind": "buckets", "unit": "m", "edges": [4, 5]}]}
(Code turns this into "Less than 4 m", "4 to 5 m", "More than 5 m" and counts the listings in each.)

EXAMPLE 4 — filter "Size" with options "10 x 10", "20 ft", "20 x 10 x 8", "5 ft", "4 x 4 x 7 ft", "3 seater", "Other" (decision A: a size filter although it holds a single length, a count and "Other"):
{"ranges": [{"filter": "Size", "kind": "dimensions", "unit": "ft", "axes": [{"name": "Length", "match": "at_most"}, {"name": "Width", "match": "at_most"}, {"name": "Height", "match": "at_most"}], "rotation_ok": true, "note": "Axis order assumed length x width x height; 10 x 10 and 20 x 10 x 8 write no unit, so ft is assumed; 20 ft and 5 ft are read as lengths.", "options": [{"value": "10 x 10", "parts": [{"axis": "Length", "number": 10, "unit": "ft"}, {"axis": "Width", "number": 10, "unit": "ft"}]}, {"value": "20 ft", "parts": [{"axis": "Length", "number": 20, "unit": "ft"}]}, {"value": "20 x 10 x 8", "parts": [{"axis": "Length", "number": 20, "unit": "ft"}, {"axis": "Width", "number": 10, "unit": "ft"}, {"axis": "Height", "number": 8, "unit": "ft"}]}, {"value": "5 ft", "parts": [{"axis": "Length", "number": 5, "unit": "ft"}]}, {"value": "4 x 4 x 7 ft", "parts": [{"axis": "Length", "number": 4, "unit": "ft"}, {"axis": "Width", "number": 4, "unit": "ft"}, {"axis": "Height", "number": 7, "unit": "ft"}]}]}]}
("3 seater" and "Other" are left out of "options".)

EXAMPLE 5 — filter "Height" with options "6 m", "25 Feet", "30 Feet", "22 Feet", "25 ft (7.5 m)", "as per requirement" (decision B: mixed units and a bracket; text left out):
{"ranges": [{"filter": "Height", "kind": "buckets", "unit": "ft", "edges": [22, 25, 30]}]}
(Code converts 6 m to ft, reads "25 ft (7.5 m)" as 25 ft, and builds "Less than 22 ft", "22 to 25 ft", "25 to 30 ft", "More than 30 ft".)
