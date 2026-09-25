# Skill 10 · Rationale, rules, blockers & output schema

What each filter must say about itself, the panel-level outputs, the final self-check, the compact JSON
schema, and a worked example. The model only *links* each filter to its evidence rows (`dimension`,
`listing_spec`); code then fills `coverage_pct`, `top_value_share_pct`, `listing_fill_pct` and `sources`
(`attachEvidence()` in `src/lib/filter-gen.ts`) — fewer output tokens and no mis-copied numbers.

- **Layer:** prompt only (the UI in `src/routes/index.tsx` renders these fields)
- **Used by:** master prompt (last section)

## Prompt

9. RATIONALE: one or two short sentences: why this filter, why this tier. Cite at least one number that appears verbatim in the evidence (coverage, share, demand, enquiries, fill %, C rank) and name its source (internal search, SERP, context doc, CM ranking, listings). If listing fill < 30%, end with e.g. "(only 12% of listings fill this — needs ISQ push)".
10. EVIDENCE LINKS: "dimension" = the A dimension name exactly, or null · "listing_spec" = the D spec name exactly, or null · "backing" = which of "context", "ranking" support it. Code fills in coverage, share and fill % from these links.
11. PANEL: "interaction_rules" = 2–4 concrete, category-specific behaviours (e.g. "Type = Toilet Cabin hides Seating Capacity"; pre-select a filter the query states). "blockers" = what must be fixed before launch: poorly filled or missing ISQ fields (quote fill %), conflicting evidence, missing inputs; [] if none.

SELF-CHECK: Tier 1 has 3–5 filters · Tier 1/2 filters have ≥ 2 real options · no two filters cover one attribute · every rationale cites evidence · Tier 3 is "display only" · every needs_new_isq filter has a blocker.

OUTPUT (compact JSON, no extra keys; "tier" is 1, 2 or 3; "isq_note" = what to add to the seller form when needs_new_isq, else null):
{"category_name": "…",
 "filters": [{"tier": 1, "rank": 1, "name": "…", "ui_pattern": "…", "values": ["…"], "confidence": "High|Medium|Low", "rationale": "…", "dimension": "…"|null, "listing_spec": "…"|null, "backing": ["context","ranking"], "needs_new_isq": false, "isq_note": null}],
 "interaction_rules": ["…"],
 "blockers": ["…"]}

EXAMPLE filter, for evidence "DIMENSION Material — INT: coverage 31.2%, top-value share 46.3%", ranking "2-Material", listings "Material | 72%":
{"tier": 1, "rank": 2, "name": "Material", "ui_pattern": "multi-select checkboxes", "values": ["PUF", "MS (Mild Steel)", "FRP", "Container-based"], "confidence": "High", "rationale": "31.2% of internal-search demand names a material and none dominates (46.3%); CM ranks it #2.", "dimension": "Material", "listing_spec": "Material", "backing": ["ranking"], "needs_new_isq": false, "isq_note": null}
