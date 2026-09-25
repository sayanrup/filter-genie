# Skill 10 · Rationale, rules, blockers & output schema

What each filter must say about itself, the panel-level outputs, the final self-check, the compact JSON
schema, and a worked example. The model only *links* each filter to its evidence rows (`dimension`,
`listing_spec`); code then fills `coverage_pct`, `top_value_share_pct`, `listing_fill_pct`, `sources`,
**and now `ui_pattern` and default `values` too** (`attachEvidence()` in `src/lib/filter-gen.ts`, see
skill 09) — no mis-copied numbers or retyped option lists, and the output budget that would have gone
to those goes to a fuller rationale and sharper interaction rules instead. The model's job per filter
is judgement only: does it exist, at what tier, why — argued well enough that a reviewer trusts it.

- **Layer:** prompt only (the UI in `src/routes/index.tsx` renders these fields)
- **Used by:** master prompt (last section)

## Prompt

9. RATIONALE: two to three sentences, not one — this is what a category manager reads to decide whether to trust the filter, so make it earn that trust. Cover, in order: (a) the strongest number from the evidence and its source (coverage, share, demand, enquiries, fill %, C rank — internal search / SERP / context doc / CM ranking / listings); (b) how steps 1–2 of skill 08 read that evidence (strong/moderate/weak demand, confirmed/neutral/contradicted); (c) anything a launch reviewer should know — a disagreement between sources, a supply gap, or why it landed in this tier and not the one above or below it. If listing fill < 30%, end with e.g. "(only 12% of listings fill this — needs ISQ push)". A rationale that only restates the filter's name in different words, without a number, fails the self-check below.
10. EVIDENCE LINKS: "dimension" = the A dimension name exactly, or null · "listing_spec" = the D spec name exactly, or null · "backing" = which of "context", "ranking" support it — include both when both genuinely do; an empty array only when neither evidence source backs this filter at all. Code fills in coverage, share, fill % and the filter's options from these links — do not invent option values or a UI pattern; leave them out of your JSON.
11. PANEL:
    - "interaction_rules": 3–5 concrete, category-specific behaviours a frontend engineer could implement without asking a follow-up question — name the exact filter and exact value that triggers each one (e.g. "Type = Toilet Cabin hides Seating Capacity"; "pre-select City from the buyer's location when available"; "selecting a Material narrows Size to that material's real range from D"). Generic advice ("show filters clearly") does not count.
    - "blockers": everything that should block a product manager from shipping this panel as-is — every needs_new_isq filter (see below), any place two evidence sources disagree and you had to pick one, and any input that was missing entirely and would have changed a tier if it had been provided. [] only when the panel is genuinely launch-ready.

SELF-CHECK before replying — fix anything that fails, then answer: Tier 1 has 3–5 filters · no two filters cover one merged attribute (skill 08 step 2) · every rationale names a number AND its source AND how it was read (strong/confirmed/etc., not just the number) · every needs_new_isq filter has a matching blocker · every interaction rule names a specific filter and value, not a generality.

OUTPUT (compact JSON, no extra keys — no "ui_pattern" or "values", code adds those; "tier" is 1, 2 or 3; "isq_note" = what to add to the seller form when needs_new_isq, else null):
{"category_name": "…",
 "filters": [{"tier": 1, "rank": 1, "name": "…", "confidence": "High|Medium|Low", "rationale": "…", "dimension": "…"|null, "listing_spec": "…"|null, "backing": ["context","ranking"], "needs_new_isq": false, "isq_note": null}],
 "interaction_rules": ["…"],
 "blockers": ["…"]}

EXAMPLE filter, for evidence "DIMENSION Material — INT: coverage 31.2%, top-value share 46.3%", ranking "2-Material", listings "Material | 72%" (this is skill 08's first worked walkthrough, carried through to its final JSON):
{"tier": 1, "rank": 2, "name": "Material", "confidence": "High", "rationale": "31.2% of internal-search demand names a material and no single value dominates it (top share 46.3%), so this is strong demand with strong discrimination. The CM ranking confirms it at #2 of the category's specs, and 72% of listings already fill it, so it's ready to launch with no ISQ work needed.", "dimension": "Material", "listing_spec": "Material", "backing": ["ranking"], "needs_new_isq": false, "isq_note": null}
