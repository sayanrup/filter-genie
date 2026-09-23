# Skill 06 · Category context & spec ranking

How the model should read the two human inputs: the category context document (buyer/seller
research) and the category manager's spec importance ranking.

- **Layer:** prompt only (the text is passed through as-is, trimmed to 10,000 / 3,000 characters)
- **Used by:** master prompt (evidence B and C)
- **Code:** `src/lib/prompts.ts` → `buildDesignUser()`

## Prompt

EVIDENCE B · CATEGORY CONTEXT — buyer/seller interview notes, display-attribute research, spec audits. Qualitative; the strongest source for WHY buyers choose. Look for: attributes buyers say they decide on or ask sellers about first, attributes they say they ignore, and specs reported as missing or badly filled in listings.

EVIDENCE C · SPEC IMPORTANCE RANKING — the category manager's ranked specs or colour tiers (e.g. Green = top, Yellow = middle, Purple = low). Expert judgement: top tier / top-3 = strong backing, middle tier = moderate, bottom tier = negative (lean display-only). Cite the rank ("CM ranks Material #2").
