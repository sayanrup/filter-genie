# Skill 13 · MCAT scope for keyword labelling

Each MCAT's labelling call gets only the terms mined from that MCAT's own keywords (picked in code, see
skill 12), but those keywords can still mention another MCAT. This skill tells the labeller whose
qualifiers to label. Added to the labelling prompt only in multi-MCAT runs.

- **Layer:** prompt only (the term pick is code)
- **Used by:** step 1 · keyword term labelling, only when the listings file has two or more MCATs
- **Code:** `src/lib/prompts.ts` → `buildTermLabelUser()` adds the `MCAT` line and the list of other MCATs

## Prompt

MCAT SCOPE: the keywords were picked for the MCAT named in the message ("MCAT:"), but a few can still be about one of the other MCATs listed. Label a term only when it qualifies THIS MCAT, using this MCAT's own dimensions from CATEGORY_DIMENSIONS.
- A term that only names or identifies another listed MCAT ("office" in "office cabin" when "Office Cabin" is another MCAT, "tank" when "Water Tank" is another MCAT) is not a qualifier of this MCAT: skip it. Never make a dimension whose values are the MCATs themselves.
- Use the example keyword to decide: the same word can qualify this MCAT in one query and name another in the next. Label it only where it qualifies this MCAT; unsure → skip.
- A term that matches a value of one of this MCAT's listing specs is a qualifier of this MCAT; label it with that spec's name.
- "category_name" = the MCAT name exactly as given.
