# Filter Genie — How Each Step Works

## Overview

Filter Genie turns category research into a ranked, tiered set of search-page filters (ISQs and their
values) for an IndiaMART-style B2B marketplace, in 6 steps: 4 are plain code, and up to 4 small model
calls fill the gaps code can't decide.

The design rule behind every step: **the model never does arithmetic, and it only sees what code can't
decide on its own.** Code reads files, counts demand, computes fill rates, writes option lists and enforces
tier rules. The model is asked for judgement only: what a keyword term means, which spec names are
synonyms, which filters matter and why.

**Inputs** (all optional; drop a file or paste text):

| #   | Input                     | Typical source                                                                                    |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Google SERP keywords      | Search Console export: query, clicks, impressions, position                                       |
| 2   | Internal search keywords  | Site-search report: keyword, pageviews, enquiries, calls, CTR                                     |
| 3   | Category context document | Buyer/seller notes, spec audits, or the category document JSON (MCATs with their ISQs and values) |
| 4   | Spec importance ranking   | The category manager's ranked specs, or live ISQs as JSON                                         |
| 5   | Product listings          | JSON / CSV / XLSX export, nested ISQ spec arrays allowed                                          |

**Outputs:** a filter table (tier, rank, name, options, confidence, rationale, coverage %, fill %), a
High / Medium / Low confidence on every value, the final selected ISQs and values, a demo search page,
warnings for every automatic fix, and exports to .md, .xlsx and .json.

The app runs in the browser with the user's own OpenRouter, Groq or LiteLLM key. A typical run is 3 to 4
model calls, about 5 to 9k input and 3k output tokens.

## Architecture

The app is a browser-only TanStack Start + React page. One TypeScript function, `runPipeline()` in
`src/lib/filter-gen.ts`, runs the 6 steps in order and reports each step's status, input, output, tokens
and cost to the page.

Three layers do the work:

- **Deterministic code** (`src/lib/data.ts`, `mcats.ts`, `value-confidence.ts`, `select-isqs.ts`) parses
  files, mines terms, totals demand, profiles listings, builds options and enforces rules.
- **Skill files** (`src/skills/*.md`) hold every instruction the model ever reads. Each file is one layer
  of the task; only its `## Prompt` section is sent.
- **The LLM client** (`src/lib/llm.ts`) sends a system prompt plus a user message to OpenRouter, Groq or the
  IndiaMART LiteLLM gateway and returns parsed JSON.

| File                               | What it does                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/routes/index.tsx`             | The page: 5 inputs, model picker, Generate, results                                          |
| `src/lib/filter-gen.ts`            | The pipeline: the 6 steps, caching, re-run from a step, auto-fixes, cost estimate            |
| `src/lib/data.ts`                  | Parsing, column detection, term mining, demand aggregation, listing flattening and profiling |
| `src/lib/prompts.ts`               | Builds each step's user message (the data blocks) and prompt budgets                         |
| `src/skills/index.ts`              | Registry: which skill files make up each step's system prompt                                |
| `src/skills/*.md`                  | The prompt layers (base + skills 01 to 15)                                                   |
| `src/lib/llm.ts`                   | Model client: JSON mode, reasoning budget, price routing, retries, timeouts                  |
| `src/lib/mcats.ts`, `run-mcats.ts` | Splits a subcategory into MCATs and runs each one on its own                                 |
| `src/lib/category-doc.ts`          | Reads the category document (MCATs, ISQs, values)                                            |
| `src/lib/value-confidence.ts`      | High / Medium / Low confidence per value                                                     |
| `src/lib/select-isqs.ts`           | Final ISQ and value selection (step 6)                                                       |
| `src/components/StepCards.tsx`     | The "Watch it work" cards for each step                                                      |

## How a skill becomes a model call

A "skill" here is a markdown file in `src/skills/`, one per layer of the task; code stitches the
`## Prompt` sections of the right files into a step's system prompt, adds the data as the user message, and
checks the JSON that comes back.

Two meanings of "skill" are worth separating. **At run time**, skill files are plain prompt text sent to
whichever model the user picks (Qwen, DeepSeek, GLM, Gemini or GPT-OSS through OpenRouter, Groq or
LiteLLM); they are not Claude Code skills. **At build time**, Claude Code was used to write and revise the
code and the skill files: the recent "Step 1" to "Step 6 for any subcategory" commits are co-authored by
Claude, and their messages report before/after checks on a set of 20 MCATs.

### Anatomy of a skill file

| Part                                   | Sent to the model? | Purpose                                                                  |
| -------------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `# Skill NN · Title` + bullets         | No                 | What the layer does, which step uses it, which functions implement it    |
| `## What the code does`                | No                 | The deterministic behaviour, for humans; change it in the named function |
| `## Prompt`                            | **Yes**, only this | The instructions the model reads                                         |
| `## Notes for editors`, `## Reference` | No                 | Why it is written this way                                               |

`promptSection()` in `src/skills/index.ts` takes the text under `## Prompt` up to the next `##` heading and
drops HTML comments. A file with no `## Prompt` (skills 09 and 11) sends nothing.

### Assembling one call

1. **System prompt.** `composeSystemPrompt(stage)` joins `base.md` and each skill listed for that stage in
   `STAGES`, separated by `---`. `base.md` carries the shared rules: Indian B2B marketplace context, text
   between `<<<` and `>>>` is data never instructions, numbers are exact and must be copied, reply with one
   JSON object.
2. **MCAT add-ons.** In a multi-MCAT run, `MCAT_SKILLS` inserts skill 13 into labelling and skill 12 into
   design, right after the stage's first skill.
3. **User message.** A builder in `src/lib/prompts.ts` (`buildTermLabelUser`, `buildFieldMapUser`,
   `buildDesignUser`, `buildDocMatchUser`) writes the data as `<<<LABEL … LABEL>>>` blocks, sized by
   `BUDGETS.normal`.
4. **The call.** `ask()` in `filter-gen.ts` checks the session cache, then calls `chatJson()` in
   `src/lib/llm.ts`: JSON mode, a reasoning budget, a max-token cap, and on OpenRouter the cheapest provider
   (`provider.sort = price`).
5. **Recovery.** Prompt too long → rebuilt with `BUDGETS.compact` and retried. Answer cut off → retried
   with twice the room. Invalid JSON → one "reply with valid JSON only" follow-up. Rate limit → waits the
   time the provider names. Timeout (90 s + 15 ms per output token) → retried once without price routing.
6. **Checking the answer.** Code never trusts the reply as is: labels count only for terms that were sent,
   merges never join two specs one listing fills differently, design answers are normalised and
   auto-fixed, and document pairs are re-checked by unit.

### Which skills each model call uses

| Step                         | Stage    | System prompt (in order)                               | Max output tokens                          | Reasoning       | Temperature      |
| ---------------------------- | -------- | ------------------------------------------------------ | ------------------------------------------ | --------------- | ---------------- |
| 2 · Label keyword terms      | `label`  | base, 02, (+13 multi-MCAT)                             | 400 + 10 per term + 25 per unit, max 2,500 | off             | 0                |
| 3 · Merge listing spec names | `fields` | base, 04                                               | 1,000                                      | off             | 0                |
| 4 · Design the filter panel  | `design` | base, 07, (+12 multi-MCAT), 01, 03, 06, 05, 08, 09, 10 | 3,200 (2,200 with UI design off)           | medium (~3,000) | provider default |
| 6 · Select ISQs & values     | `select` | base, 15                                               | 300 + 150 per ISQ, max 1,800               | off             | provider default |

Skill 11 (output validation) is code only. Skill 14 (numeric ranges) is switched off; its code stays so
old saved results still show ranges.

### Changing a step's behaviour

- Wording or rules the model follows → edit that skill's `## Prompt`. Nothing else needs to change.
- Deterministic behaviour → edit the function the skill's header names.
- A new layer → create the `.md`, import it in `src/skills/index.ts`, add it to a stage in `STAGES`.
- **View prompts** (next to Generate) shows each step's assembled system prompt with file names and the
  exact data sent, before or after a run.

## Step-by-step walkthrough

Every Generate runs the same 6 steps per MCAT; steps 1 and 5 are pure code, and steps 2, 3, 4 and 6 each
make at most one model call (plus retries) whose answer code checks before using it.

```
                 ┌──────────────────────────────────────────────────┐
                 │  Inputs · keywords, context, ranking, listings   │
                 └─────────────────────────┬────────────────────────┘
                                           ▼
                 ┌──────────────────────────────────────────────────┐
                 │  1 · Read and total the data             [code]  │
                 │  parse files, pick keywords, mine terms,         │
                 │  flatten listings                                │
                 └─────────────────────────┬────────────────────────┘
                                           │   in parallel
                     ┌─────────────────────┴─────────────────┐
                     ▼                                       ▼
   ┌───────────────────────────────────┐   ┌───────────────────────────────────┐
   │  2 · Label keyword terms          │   │  3 · Merge listing spec names     │
   │  [MODEL] skill 02 (+13 for MCATs) │   │  [MODEL] skill 04                 │
   │  each search term →               │   │  same spec written two ways →     │
   │  dimension + value                │   │  one name                         │
   └─────────────────┬─────────────────┘   └─────────────────┬─────────────────┘
                     └─────────────────────┬─────────────────┘
                                           ▼   labels renamed, demand totalled (code, skill 03)
                 ┌──────────────────────────────────────────────────┐
                 │  4 · Design the filter panel            [MODEL]  │
                 │  master prompt · skills 07, 01, 03, 06, 05,      │
                 │  08, 10 (+12 for MCATs)                          │
                 │  which filters, which tier and rank, how         │
                 │  confident, why                                  │
                 └─────────────────────────┬────────────────────────┘
                                           ▼
                 ┌──────────────────────────────────────────────────┐
                 │  5 · Check and fix the output            [code]  │
                 │  skills 09, 11 · fills numbers and options,      │
                 │  auto-fixes, value confidence                    │
                 └─────────────────────────┬────────────────────────┘
                                           ▼
                 ┌──────────────────────────────────────────────────┐
                 │  6 · Select ISQs and values   [code + ≤1 MODEL]  │
                 │  skill 15 · cleans values, pairs with the        │
                 │  category document, picks shown ISQs             │
                 └─────────────────────────┬────────────────────────┘
                                           ▼
                 ┌──────────────────────────────────────────────────┐
                 │  Result · filter table · value confidence ·      │
                 │  selected ISQs · exports                         │
                 └──────────────────────────────────────────────────┘
```

| Step | Card name                | Runs as                       | Skill files                        | Skipped when                                                 |
| ---- | ------------------------ | ----------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| 1    | Read & total the data    | Code only                     | 01, 02, 04, 12 (code parts)        | Never                                                        |
| 2    | Label keyword terms      | Model call + code checks      | 02 (+13)                           | No keywords, or nothing left to label                        |
| 3    | Merge listing spec names | Model call + code checks      | 04, 05                             | No listings, or fewer than 2 spec names                      |
| 4    | Design the filter panel  | Master prompt + code checks   | 07, 12, 01, 03, 06, 05, 08, 09, 10 | Never (reused only on a re-run from step 5 or 6)             |
| 5    | Check & fix the output   | Code only                     | 09, 11                             | Never                                                        |
| 6    | Select ISQs & values     | Code + at most one model call | 15                                 | The call is skipped when nothing needs the category document |

Steps 2 and 3 run in parallel. The model-call titles in "View prompts" are numbered by call, not by step:
"1 · Label" is step 2, "2 · Merge" is step 3, "3 · Master prompt" is step 4, "4 · Category document" is
step 6.

### Step 1 · Read & total the data

**What it does:** turns every raw input into clean tables, with no model involved.

**How it runs:** `prepare()` and `withCategoryDoc()` in `src/lib/filter-gen.ts`, calling `src/lib/data.ts`
and `src/lib/mcats.ts`.

1. **Category document.** If input 3 (or 4) is the category-document JSON, it is recognised by its shape
   (MCATs with ISQs and values). Its notes for this MCAT become the context (B); its ISQs are kept for step 6
   only. Live ISQs as JSON in input 4 become this MCAT's ranking (C), in order.
2. **Keyword files** (skill 01). Reads .xlsx, .csv, .json or pasted text, up to 5,000 rows. Detects the
   query column, the demand metric (Pageviews, Clicks…), the action metric (Enquiries, Calls…) and rate
   columns. Normalises each query (`20 ft` → `20ft`, `₹` → `rs`, Hindi digits kept) and merges duplicates.
3. **Per-MCAT keyword pick** (skill 12, multi-MCAT runs). A file with an MCAT ID column is cut by that
   column. Otherwise `selectMcatKeywords()` matches words against every MCAT's name, PMCAT and own listing
   words, with a word-break step for run-together words and typo clusters. A file with fewer than 10
   keywords for an MCAT is left out for it, with a warning.
4. **Term mining** (skill 02). Finds core words (in at least 40% of keywords and part of the MCAT/PMCAT
   name), single words and recurring two-word phrases. A number stays with the word after it (`150 cc` →
   `150cc`), and number terms are grouped by that unit word. The top 150 other terms go to step 2.
5. **Listings** (skill 04). Takes up to 500 listings evenly, flattens nested JSON, turns ISQ arrays
   (`prd_isq`, name/value pairs) into spec keys, and maps fields by rule: ids, URLs and contacts ignored;
   name, price and unit recognised; the rest become canonical spec names.
6. **Dimension names.** The ranking's spec names plus listing specs filled on at least 3% of listings, so
   keywords, ranking and listings later share one vocabulary.

**Output:** keyword tables, mined terms, unit groups, flat listings, spec summary, dimension names. The
card shows counts (keywords, terms mined, unit words, listings, spec fields) and a warning when there are
fewer than 10 listings.

### Step 2 · Label keyword terms

**What it does:** the model says what each mined search term means: its filter dimension and clean
buyer-facing value.

**How it runs:** `labelTask()` in `filter-gen.ts`. System prompt = `base.md` + skill 02 (+ skill 13 when
the file holds several MCATs). User message from `buildTermLabelUser()`:

- `MCAT` block (multi-MCAT): this MCAT and up to 40 sibling MCATs a term might name
- Category core words, so the model skips them
- `CATEGORY_DIMENSIONS`: ranked specs and listing spec names with common values
- `CATEGORY_CONTEXT_EXCERPT`: 1,200 characters of the context doc about those specs
- `EXAMPLES`: worked cases built from this MCAT's own data (a listing value, a short form, a unit word, a
  sibling name)
- `TERMS` (term | example keyword) and `UNIT_TERMS` (unit | numbers seen | example). No demand figures are
  sent.

**Model returns:** `{"category_name", "dimensions": {dimension: {value: [terms]}}, "units": {unit word:
{dimension, unit}}}`. Reasoning off, temperature 0.

**Code checks:** `parseLabels()` keeps labels only for terms that were sent. `parseUnits()` keeps only
units that were sent, allows a respelling (`ltr` → `L`) but drops a swap to another unit. `numberLabels()`
then labels every number of that unit (`150cc` → `Engine Displacement: 150 cc`). An empty answer for 10 or
more terms is not cached and is retried once with a firmer note.

**Output:** term labels. The card shows terms labelled, share labelled, unit words labelled and dimensions
used; "See the working" lists the terms left unlabelled.

### Step 3 · Merge listing spec names

**What it does:** the model says which listing spec names are the same attribute written differently, and
which are not product specs, so fill rates are counted once per real spec.

**How it runs:** `fieldTask()` in `filter-gen.ts`, in parallel with step 2. System prompt = `base.md` +
skill 04. User message from `buildFieldMapUser()`: the listing count and a `SPECS` block of up to 60 specs
(filled on at least 2%) as `spec | fill % | most common values (counts)`. Seller City is never sent; code
keeps it as location evidence.

**Model returns:** `{"merge": {kept name: [names]}, "drop": [names]}`. Reasoning off, temperature 0, 1,000
tokens.

**Code checks:** `applySpecMerges()` applies the answer to all listings, but never joins two names that one
listing fills with different values, and the merged spec keeps one of the sellers' own names, never a new
one. `profileListings()` (skill 05) then computes fill %, common values and price quartiles in the most
common price unit. If the call fails, the code-only mapping is used and a warning says so.

**Handover to step 4:** `specRenames()` renames step 2's dimensions the way step 3 merged them ("Scooter
Brand" → "Brand"), so demand and fill rate share one name. `aggregate()` (skill 03) then totals demand per
dimension and value per source: coverage, top-value share, generic share, longest match first.

### Step 4 · Design the filter panel (the master prompt)

**What it does:** the model decides which filters exist, their tier and rank, their confidence and why. It
does not write option lists or numbers.

**How it runs:** `ask("design", …)` in `filter-gen.ts`. System prompt = `base.md` + skills 07 (role), 12
(MCAT scope, multi-MCAT only), 01, 03, 06, 05 (how to read evidence A to D), 08 (method), 09 (no prompt
text), 10 (rationale and JSON schema). User message from `buildDesignUser()`:

| Block              | Evidence              | What is in it                                                                                                           |
| ------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `MCAT_SCOPE`       | Scope                 | This MCAT, its siblings, how much evidence it has                                                                       |
| `KEYWORD_EVIDENCE` | A · demand            | Dimension tables per source (INT and SERP side by side): coverage, top-value share, up to 8 values each, top 8 keywords |
| `CONTEXT`          | B · why buyers choose | Up to 4,500 characters of the context doc, picked by relevance to this category's specs                                 |
| `RANKING`          | C · ranking           | CM ranking or live ISQ order, up to 1,500 characters, headed with whose it is                                           |
| `LISTINGS`         | D · supply            | Specs filled on at least 5% (1% for a demo sample), top 4 values, price quartiles                                       |

**The method the model follows** (skill 08, per candidate):

1. Candidates from demand (coverage strong at 10% or more; discrimination strong when top-value share is
   under 70%).
2. Confirm against B and C.
3. Add specs B or C name that buyers don't search.
4. Check supply (under 30% fill → `needs_new_isq`, never a demotion).
5. Confidence High / Medium / Low.
6. Tiers: at most 6 filters, Tier 1 holds 3 to 4.
7. Order within a tier: kind → material → size.

Price and Location are never filters.

**Model returns** (skill 10): `{"category_name", "filters": [{tier, rank, name, confidence, rationale,
dimension, listing_spec, backing, needs_new_isq, isq_note}], "interaction_rules", "blockers"}`. Each
rationale must cite a number, its source and how it was read. Reasoning medium, 3,200 tokens.

**Code checks:** `normalizeResult()` fixes tier and confidence spellings. `designChecks()` flags rule
breaks as "Design check" warnings: more than 6 filters, Tier 1 outside 3 to 4, a price or location filter,
a filter named after a sibling MCAT, two filters for one attribute, a filter linked to no evidence, an
interaction rule naming no filter, a `needs_new_isq` with no blocker. No filters at all stops the run with
an error.

### Step 5 · Check & fix the output

**What it does:** code fills in every number and option from the evidence links, then enforces the rules.
No repair call is made.

**How it runs:** `attachEvidence()`, `deriveOptions()`, `fixResult()` and `valueConfidence()` in
`filter-gen.ts` and `value-confidence.ts` (skills 09 and 11).

1. **Numbers.** Each filter's `dimension` and `listing_spec` links are looked up to fill coverage %,
   top-value share % and listing fill %. A link to a name not in the evidence is cleared.
2. **Options.** The keyword dimension's values (share of demand) and the listing spec's values (share of
   listings), one value written two ways counted once. The 8 biggest at 3% or more stay; the rest fold into
   "Other". The UI pattern follows the shape: numbers → range buckets, up to 4 values → single-select, more
   → multi-select.
3. **Auto-fixes.** Tier 1 over 4 → extras to Tier 2; over 6 filters → best 6 kept; Tier 1 under 3 → best
   Tier 2 promoted; fewer than 2 options → Tier 3; over 12 options → 11 + Other; bare numbers removed; price
   and location filters removed; duplicates removed; ranks renumbered; a blocker added for each
   `needs_new_isq`.
4. **Value confidence.** High at 20% or more of the dimension's demand or of the spec's filled listings,
   Medium at 5%, else Low. A listing share counts for High only on 3 or more listings.

**Output:** the final filter table. Every fix is listed under warnings as "Auto-fixed: …", so nothing
changes silently.

### Step 6 · Select ISQs & values

**What it does:** decides which ISQs and which of their values are finally shown, using the category
document only for measurements and thin ISQs.

**How it runs:** `selectIsqs()` and `checkSelection()` in `src/lib/select-isqs.ts`, with `quantity.ts` and
`category-doc.ts` (skill 15).

1. **Pair with the document.** `isqsNeedingDoc()` finds measurements and thin ISQs (one High value or
   none). Measurements are paired in code by name or unit (`Size` ↔ `Cabin Size`, a `cc` figure ↔ the
   document ISQ in `cc`). Only the rest go to the model.
2. **The model call** (only if something is left): system prompt = `base.md` + skill 15; user message has
   `ISQS` and `DOCUMENT_ISQS` blocks. It returns `{"matches": [{isq, doc, values: {ours: theirs}}]}`.
   `parseDocPairs()` re-checks each pair. If the call fails, identical names and values are still paired.
3. **Clean values.** Measurements take one unit and one shape (the document's values when paired).
   Duplicates merge by meaning (`MS` = `Mild Steel`, `Aluminum` = `Aluminium`); junk such as `Other` or
   `As per requirement` goes. Thin ISQs get up to 3 values from listings or the document. Text ISQs drop
   values that don't belong (the MCAT's own name, figures among words).
4. **Pick what is shown.** Values: High and Medium only; with 3 or more High, only High; numbers listed
   smallest first. ISQs: every Tier 1 and every Tier 2 High; never Tier 3, Price or Location; at least 3 per
   MCAT, topped up from live ISQs then the document. The ranking breaks ties only.
5. **Final check.** `checkSelection()` verifies every rule again. A failure becomes a "Check failed"
   warning and marks the step as an error.

**Output:** each filter carries `selected`, `selected_values`, `value_confidence` (with the source of each
value) and, for measurements, `unit`. The result is then named after its MCAT, with MCAT id, PMCAT and
subcategory attached.

## Running it yourself

Clone the repo, run `npm i` then `npm run dev`, open http://localhost:8080, paste a model API key, load
inputs and press Generate. The IndiaMART context and ISQ APIs only answer on the IndiaMART network, so
fetch scripts and the "Load spec audit" button need that network.

### Setup

```sh
npm i
npm run dev      # http://localhost:8080
npm run lint
npm run build
```

The project is connected to Lovable: commits pushed to the connected branch sync back to the Lovable
editor, so keep that branch working and never force-push it.

### A run, click by click

1. **Pick a model.** In the model picker choose OpenRouter, Groq or LiteLLM and paste the key. Groq's free
   tier (GPT-OSS 120B) costs nothing and is good for testing prompt changes; DeepSeek V4.1 Flash on
   OpenRouter has given the best results so far.
2. **Load inputs.** Drop files into any of the 5 inputs. For a subcategory, a product JSON with several
   MCATs makes the page list them, with how many keywords each one got, before you run.
3. **Check the prompts (optional).** "View prompts" shows each step's assembled system prompt, the skill
   files it came from, and the data that will be sent. The button bar shows a live cost estimate.
4. **Generate.** Each step gets a card with status, time, model calls, tokens and ₹ cost. "See the working"
   opens the exact input and output of that step.
5. **Re-run from a step.** "Re-run from here" asks the model again for that step and everything after it,
   and reuses cached answers above it. Re-running step 4 costs one call; re-running step 5 costs nothing.
6. **Save.** "Save results" keeps the run in the browser (and shared storage when set up) and downloads
   .md, .xlsx and .json. Multi-MCAT runs also offer "Export all MCATs (.xlsx)".

### Helper scripts

| Command                                               | What it does                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `npx tsx scripts/fetch-mcat-context.ts <ids or list>` | Pulls each MCAT's Seller & Buyer Spec Audit into `saved-results/mcat-context.json`, the category document for input 3 |
| `npx tsx scripts/fetch-isq.ts <ids or list>`          | Pulls each MCAT's live ISQs and options (needs `GETISQ_TOKEN` in `.env.local`), for input 4                           |
| `npx tsx scripts/save-local.ts <file.json>`           | Files a downloaded run into `saved-results/<category>-<date>/` as result.json, filters.xlsx and filters.md            |
| `npx tsx scripts/import-published.ts <file.xlsx>`     | Adds an Excel export to the shared "View saved results" list                                                          |
| `npx tsx scripts/import-published-md.ts <file.md>`    | Same, from a saved .md                                                                                                |

`GET /api/mcat-context?mcat_id=<id>` returns one MCAT's audit as JSON, or as markdown with
`&format=markdown`.

### Using Claude Code to change a step

The recent step-by-step improvements were made this way, and it is the easiest way for someone new to
extend the pipeline:

1. Open the repo in Claude Code and name the step and the problem ("Step 5: Capacity is read as a place").
2. Claude reads the step's skill file and the functions its header names, then edits the `## Prompt` text,
   the code, or both.
3. Re-run the same MCATs with "Re-run from here" on that step and compare against the earlier run: the
   commits report checks such as "values shown 208 → 269 on 20 MCATs".
4. Commit with a message that says what changed per step, then push to the connected branch.

## Reference

### Skill files

| File                               | Layer                                              | Used in step                          | Sends prompt text? |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------- | ------------------ |
| `base.md`                          | Shared context and ground rules                    | Every model call                      | Yes                |
| `01-parse-keyword-files.md`        | Reading keyword exports; demand and action metrics | 1 (code), 4 (prompt)                  | Yes                |
| `02-derive-specs-from-keywords.md` | Term mining and labelling                          | 1 (code), 2 (prompt)                  | Yes                |
| `03-demand-aggregation.md`         | Coverage, top-value share, generic share           | Handover 3→4 (code), 4 (prompt)       | Yes                |
| `04-parse-product-json.md`         | Flattening listings; merging spec names            | 1 (code), 3 (prompt)                  | Yes                |
| `05-listing-spec-profile.md`       | Fill rates, common values, price quartiles         | 3 (code), 4 (prompt)                  | Yes                |
| `06-context-and-ranking.md`        | Reading the context doc and ranking                | 4                                     | Yes                |
| `07-filter-design-brief.md`        | Master prompt role and goal                        | 4                                     | Yes                |
| `08-scoring-and-tiering.md`        | The 7-step scoring and tiering method              | 4                                     | Yes                |
| `09-filter-options-and-ui.md`      | Options and UI pattern, built by code              | 5                                     | No                 |
| `10-rationale-and-output.md`       | Rationale, rules, blockers, JSON schema            | 4                                     | Yes                |
| `11-output-validation.md`          | Checks and auto-fixes                              | 5                                     | No                 |
| `12-mcat-scope.md`                 | One MCAT of a subcategory                          | 1 (code), 4 (prompt, multi-MCAT only) | Yes                |
| `13-mcat-labelling.md`             | Whose qualifiers to label                          | 2 (multi-MCAT only)                   | Yes                |
| `14-numeric-ranges.md`             | Lower and upper bounds                             | Switched off                          | Not sent           |
| `15-select-isqs.md`                | Final ISQ and value selection                      | 6                                     | Yes                |

### Glossary

| Term                      | Meaning                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| MCAT                      | One product category page, e.g. Diesel Generator. Each MCAT gets its own run.                                           |
| PMCAT                     | An MCAT's primary parent category; its name helps pick the MCAT's keywords.                                             |
| Subcategory               | A group of MCATs in one product file, designed MCAT by MCAT in one Generate.                                            |
| ISQ                       | A structured spec field sellers fill on a listing (Material, Size). The filters are ISQs; their options are ISQ values. |
| Live ISQs                 | The ISQs on today's seller form, in priority order (from `fetch-isq.ts`).                                               |
| Category document         | Per MCAT, the "Buyer Attracting Seller Specs" table of its spec audit: ISQs and their values.                           |
| Evidence A / B / C / D    | Keyword demand / category context / spec ranking / listing spec profile.                                                |
| Dimension                 | A filterable attribute buyers type into search, with values (Material: Steel, Wood).                                    |
| Coverage                  | % of a source's keyword demand whose keywords state the dimension.                                                      |
| Top-value share           | % of a dimension's demand held by its biggest value; low means buyers split across options.                             |
| Generic share             | % of demand from keywords with no qualifier at all.                                                                     |
| Fill %                    | % of listings that fill a spec. 60% or more is ready; under 30% needs ISQ work.                                         |
| Tier 1 / 2 / 3            | Always visible / under "More filters" / shown on the listing card, not a filter.                                        |
| Filter confidence         | The model's High / Medium / Low judgement of the whole filter (skill 08).                                               |
| Value confidence          | Code's High (20% or more) / Medium (5%) / Low for each value, from demand or listing share.                             |
| Thin ISQ                  | An ISQ with one High value or none; only these are topped up from listings or the document.                             |
| `needs_new_isq` / blocker | A filter sellers don't fill yet, and the launch blocker that names it.                                                  |

### Troubleshooting

| Message                                                           | What to do                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| "The model returned no filters"                                   | Run again or pick another model.                                                                        |
| "Even the compact prompt doesn't fit this model's context window" | Use a larger-context model (Gemini 3.1 Flash Lite, DeepSeek V4.1 Flash) or shorten the context doc.     |
| "The model labelled none of the N keyword terms"                  | Open "See the working" on step 2 to read the reply; try another model.                                  |
| "The model didn't answer within Xs, twice"                        | The provider is overloaded; retry or switch model.                                                      |
| A Groq model "does not exist"                                     | Groq changed its free-tier list; check console.groq.com/docs/models.                                    |
| "Keywords: only N of the … keywords are about …"                  | Fewer than 10 keywords matched that MCAT, so that file was left out for it; expected for small MCATs.   |
| "Couldn't reach the MCAT API"                                     | Run the app locally on the IndiaMART network.                                                           |
| "Check failed: …"                                                 | A step-6 rule didn't hold; read "See the working" on the Select card.                                   |
| "Design check: …"                                                 | The design answer broke one of its own rules; step 5 fixes most of them, and the rest stay as warnings. |
