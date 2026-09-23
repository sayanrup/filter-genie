# Skill 01 · Parse keyword files

Turns uploaded or pasted keyword exports (Google Search Console, internal site-search reports)
into clean keyword tables with one demand number per keyword.

- **Layer:** code (deterministic) + a prompt section that explains the numbers to the design model
- **Used by:** master prompt (evidence A)
- **Code:** `src/lib/data.ts` → `textToRows()`, `fileToRows()`, `toKeywordTable()`, `normalizeQuery()`

## What the code does

1. **Reads anything:** `.xlsx`, `.csv`, `.json`, or pasted CSV / TSV / semicolon / pipe text, or a plain
   one-keyword-per-line list. Header rows are auto-detected. Up to 5,000 rows.
2. **Detects columns:**
   - *query* — a text column named like query / keyword / search term.
   - *demand metric* — internal search: Pageviews → Searches/Volume → Sessions → Impressions → Clicks;
     SERP: Clicks → Impressions → Volume. With no numeric column, every keyword counts as 1.
   - *action metric* — Enquiries approved → Enquiries → Leads → Calls → CTA clicks → Conversions.
   - *rate metrics* — CTR / conversion-rate style columns (%, 0–1 fractions); averaged weighted by demand.
3. **Normalises queries** so signals become single tokens: `20 x 10` → `20x10`, `20 ft` → `20ft`,
   `sq ft` → `sqft`, `₹` → `rs`, `near me` → `near-me`. Duplicate queries are merged and their metrics summed.

To support a new report layout, extend the regex lists `DEMAND_PATTERNS` / `ACTION_PATTERNS` in `data.ts`.

## Prompt

EVIDENCE A · KEYWORD DEMAND — real search keywords for this category from up to two sources:
- Internal site search = on-platform buying intent; the PRIMARY signal for filter design.
- Google SERP (Search Console) = external demand; use it to confirm or fill gaps. When the two disagree, say so in the rationale.
For each source the evidence names its "demand metric" (e.g. Pageviews or Clicks — how many buyers), its "action metric" when present (e.g. Enquiries, Calls — how many buyers acted), and any rate metrics (CTR, conversion %, demand-weighted). A value with a high action/demand ratio matters more than its raw demand suggests.
