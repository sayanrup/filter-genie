# Skill 06 · Category context & spec ranking

How the model should read the two human inputs: the category context document (buyer/seller
research) and the category manager's spec importance ranking.

- **Layer:** prompt only. The context doc is sent as a **relevance-picked excerpt** of up to 4,500 characters
  (1,800 in the compact retry): code splits it into ~400-character passages, scores each by how many of the
  category's dimension names, top values and listing spec names it mentions plus buyer-decision words, and
  keeps the best ones in document order (`excerpt()` in `src/lib/prompts.ts`). The ranking is trimmed to
  1,500 characters.
- **Used by:** master prompt (evidence B and C)
- **Code:** `src/lib/prompts.ts` → `buildDesignUser()`

## Prompt

EVIDENCE B · CATEGORY CONTEXT: research notes (possibly an excerpt). Qualitative; the best source for WHY buyers choose. Look for attributes buyers decide on or ask about first, ones they ignore, and specs reported missing or badly filled.

EVIDENCE C · SPEC IMPORTANCE RANKING: the category manager's ranked specs or colour tiers (Green = top, Yellow = middle, Purple = low). Top tier / top 3 = strong backing, middle = moderate, bottom = negative (lean display-only). Cite the rank ("CM ranks Material #2").
