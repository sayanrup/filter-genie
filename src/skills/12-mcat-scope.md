# Skill 12 · MCAT scope (several MCATs in one Generate)

When the product file holds several MCATs, the app designs each MCAT's filters in its own run, so
keyword demand, fill rates, option values and price are all counted for that MCAT alone. This skill is
added to the master prompt only in those runs.

- **Layer:** code (the split and the keyword pick) + prompt (this scope)
- **Used by:** master prompt, only when the listings file has two or more MCATs. Placed right after the
  role in skill 07, so the rest of the method is read with the scope in mind.
- **Code:** `src/lib/mcats.ts` → `splitByMcat()`, `selectMcatKeywords()`; `src/lib/prompts.ts` →
  `buildDesignUser()` (the `MCAT_SCOPE` block); `src/lib/run-mcats.ts` (the runs)

## What the code does

1. **MCATs** are the groups of the product JSON: an array of wrappers
   (`[{"input_mcat": {"id", "name"}, "primary_pmcat": {...}, "products": [...]}, ...]`), an object with one
   array per MCAT (`{"portable-cabins": [...], ...}`), or the values of an `mcat` column. Each record is tagged
   `_group` (name), `_mcat_id`, `_pmcat` and `_pmcat_id`; the id and PMCAT travel with the result
   (`mcat_id`, `pmcat`).
2. **Listings** are cut per MCAT: fill rates, common values and the price range in evidence D are that
   MCAT's own.
3. **Keywords: the files are common to all MCATs, but each MCAT works on its own keywords.** Before any model
   call, code picks them (`selectMcatKeywords()`), with no model involved:
   - **One word index for the whole run** (`buildMatchers()`): every word maps to the MCATs that own it — a word
     of the MCAT's name (worth 3), of its primary PMCAT's name (2), or of its listings' own vocabulary (1;
     `distinctiveVocab()`: spec words on ≥ 5% of its listings and on no other MCAT's). A word several MCATs
     share has its weight split between them, so "oven" (in a dozen MCAT names) can't decide alone.
   - **A keyword is broken into words** and each word is looked up; "500lph" gives "lph", and a run-together
     word like "bulkmilkcooler" is cut into the index's words by a memoised word-break DP (fewest pieces).
   - **Word clusters** (`variantMap()`): the keyword file's own words are put in buckets by string similarity
     (SymSpell-style one-letter-deletion buckets plus a shared-prefix bucket) and compared only within a bucket.
     A word that is a variant of an MCAT's word — a typo or another ending ("pasteuriser", "homogeniser",
     "bakary", "machinery") — joins that word's cluster and counts as it. Clusters form only around MCAT words,
     so look-alike words can't chain into each other.
   - **Coverage, not a score.** A keyword's coverage of an MCAT is the share of the MCAT's name weight it holds
     ("bakery oven" holds all of Bakery Oven and a sliver of Combi Oven; "oven" alone a fifth of Bakery Oven).
     The keyword is the MCAT's when coverage ≥ 0.5 and ≥ 0.75 × the best coverage any MCAT gets from it, so
     a loose match can't take a keyword that clearly belongs to another MCAT. A word in nearly every keyword of
     the file is ignored.
   - **Listing words must be confirmed.** A word only the MCAT's listings use ("genset") counts only if the
     keywords holding it that are already assigned by name go mostly (≥ 60%, from ≥ 2) to that MCAT. "Sale" or
     "small" are spread over every MCAT and never count.
   Terms are mined, labelled and totalled from those keywords alone, so coverage and share in evidence A are
   of this MCAT's keywords. A keyword file with fewer than 10 such keywords is left out for the MCAT; with
   none left, evidence A is absent and the panel rests on D, B and C. A keyword that shares no word with the
   MCAT's name, PMCAT or listings is missed — that is the limit of word matching.
4. **Context and ranking** are cut per MCAT only when the document marks sections: a line that is just
   the MCAT's name (`## Portable Cabins`, `MCAT: Portable Cabins`, `Portable Cabins:`) starts that MCAT's
   section. Text above the first such line is shared by every MCAT. A document with no such lines is
   shared whole.
5. **One run per MCAT**, one at a time; one failing doesn't stop the others.

## Prompt

MCAT SCOPE: this run covers ONE MCAT, one of several in the same file. The MCAT_SCOPE block in the user message names it, lists the other MCATs (each is designed in its own call, with its own listings) and says how much evidence this MCAT has. Design this MCAT's panel as if the others did not exist.
- KEYWORDS (A) were picked for this MCAT: code kept the keywords about it (its name, its PMCAT, or words only its own listings use), and MCAT_SCOPE says how many and what share of the file's demand they hold. They can still mention another MCAT. A dimension that exists only in A, with no support in B, C or D for this MCAT, is most likely about another MCAT: leave it out, or keep it Tier 3 with Low confidence.
- D, B and C are this MCAT's own. Judge fill rates, values and price from this MCAT's D only. Never reason "the other MCATs have this spec, so it belongs here too", and never carry a tier or option across from another MCAT.
- Do not make a filter whose options are the MCATs themselves (e.g. "Type: Portable Cabin / Office Cabin / Security Cabin" when those are the other MCATs' names). Choosing between MCATs is navigation between pages, not a filter. A "Type" filter is right only when D or B shows buyers choosing between variants inside this MCAT.
- Use the evidence's own names for dimensions and specs exactly as written ("Material", not a rewording), so the same attribute carries the same name in every MCAT's panel.
- Thin evidence: when MCAT_SCOPE reports few listings, no section in the context or ranking for this MCAT, or a keyword file left out for lack of keywords about it, say so in the rationale of every filter that leans on that evidence, cap its confidence at Medium (Low when nothing else backs it), and add one blocker naming what is thin. Do not fill the gap with what you know of the other MCATs.
- "category_name" = the MCAT name exactly as given. "interaction_rules" and "blockers" are about this MCAT's panel only.
