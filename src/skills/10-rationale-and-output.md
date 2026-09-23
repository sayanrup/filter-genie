# Skill 10 · Rationale, rules, blockers & output schema

What each filter must say about itself, the panel-level outputs, the final self-check, the JSON schema
the UI renders, and a worked example.

- **Layer:** prompt only (the UI in `src/routes/index.tsx` renders these fields)
- **Used by:** master prompt (last section)

## Prompt

8. RATIONALE — 1–2 plain sentences for a product manager: why this filter, why this tier. It MUST cite at least one number copied from the evidence (coverage, demand, enquiries, share, rate, fill %, or C rank) and name its source ("internal search", "SERP", "context doc", "CM ranking", "listings"). If no number exists, name the source the call rests on.

9. EVIDENCE FIELDS per filter — "sources": which of "internal", "serp", "context", "ranking", "listings" support it; "coverage_pct": the highest coverage % for this dimension in A (null if not in A); "top_value_share_pct": the matching top-value share (null if not in A); "listing_fill_pct": fill % of the matching spec in D (null if D is absent or has no such spec).

10. PANEL OUTPUTS
    - interaction_rules — 2–5 concrete, category-specific behaviours: dependencies ("Selecting Type = Toilet Cabin hides Seating Capacity"), auto-applying a filter when the query already states it ("'puf cabin' pre-selects Material = PUF"), defaults, or sort interplay.
    - blockers — what must be fixed before launch: missing or poorly filled ISQ fields (quote the fill %), conflicting evidence, missing inputs that lower confidence. [] if none.

SELF-CHECK before answering — fix anything that fails:
☐ Tier 1 has 3–5 filters.  ☐ Tier 1 and Tier 2 filters each have ≥ 2 real options.  ☐ No two filters cover the same attribute.
☐ Every rationale cites evidence; every number appears in the evidence verbatim.  ☐ Tier 3 items use "display only".
☐ needs_new_isq is true exactly where supply is a gap, and each such filter has a matching blocker.

OUTPUT:
{
  "category_name": "string",
  "filters": [
    {
      "rank": 1,
      "tier": "Tier 1" | "Tier 2" | "Tier 3",
      "name": "buyer-facing filter label",
      "ui_pattern": "one of the patterns above",
      "values": ["option", "..."],
      "confidence": "High" | "Medium" | "Low",
      "rationale": "1–2 sentences citing evidence",
      "sources": ["internal", "serp", "context", "ranking", "listings"],
      "coverage_pct": number | null,
      "top_value_share_pct": number | null,
      "listing_fill_pct": number | null,
      "needs_new_isq": boolean,
      "isq_note": "what to add to the seller form, or null"
    }
  ],
  "interaction_rules": ["string"],
  "blockers": ["string"]
}

WORKED EXAMPLE (illustrative numbers — your answer uses the real evidence and has many more filters)
Evidence excerpt:
  DIMENSION Material — Internal search: coverage 31.2%, top-value share 46.3%, 58 kws · Google SERP: coverage 18.4%, top-value share 52%
    PUF | 24 kws | 4,120 pageviews | 46.3% | 310 enquiries
    MS (Mild Steel) | 19 kws | 2,870 | 32.3% | 260
    FRP | 9 kws | 1,390 | 15.6% | 140
    Container-based | 6 kws | 510 | 5.7% | 30
  CM ranking: "Green (top): 1-Size, 2-Material, 3-Application"
  Listing profile: Material | 72% filled | PUF (31), MS (22), FRP (9)
Resulting filter:
{"rank": 2, "tier": "Tier 1", "name": "Material", "ui_pattern": "multi-select checkboxes", "values": ["PUF", "MS (Mild Steel)", "FRP", "Container-based"], "confidence": "High", "rationale": "31.2% of internal-search demand names a material and no single one dominates (PUF holds 46.3%); the CM ranks Material #2.", "sources": ["internal", "serp", "ranking", "listings"], "coverage_pct": 31.2, "top_value_share_pct": 46.3, "listing_fill_pct": 72, "needs_new_isq": false, "isq_note": null}
