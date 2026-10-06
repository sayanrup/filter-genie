import { comparisonMarkdown, type ContextComparison } from "./compare";
import type { FilterResult } from "./filter-gen";
import { filterRangeText, rangeLines } from "./ranges";
import { VALUE_CONFIDENCE_RULE, valuesWithConfidence } from "./value-confidence";

/** Inputs as stored with a saved run: keyword/listing rows are JSON strings, docs are plain text. */
export interface InputBundle {
  serp: string;
  internal: string;
  context: string;
  specs: string;
  products: string;
}

function mdCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

const FENCE_MAX = 20000;

function fence(label: string, body: string, lang = "text") {
  if (!body.trim()) return "";
  // Say so when an input is cut, instead of leaving what looks like a complete (but broken) block.
  const cut =
    body.length > FENCE_MAX
      ? `\n[… cut here: ${(body.length - FENCE_MAX).toLocaleString()} more characters not included in this file]`
      : "";
  return `### ${label}\n\n\`\`\`${lang}\n${body.slice(0, FENCE_MAX)}${cut}\n\`\`\`\n\n`;
}

export function buildMarkdown(opts: {
  name: string;
  savedAt: string;
  model: string;
  result: FilterResult;
  inputs: InputBundle;
  device?: string;
  /** Extra markdown section placed before the inputs (e.g. the with/without-context comparison). */
  extra?: string;
  /** Say the inputs are the same as an earlier part of the file instead of repeating them. */
  sameInputsNote?: string;
}) {
  const { name, savedAt, model, result, inputs, device, extra, sameInputsNote } = opts;
  const order: Record<string, number> = { "Tier 1": 0, "Tier 2": 1, "Tier 3": 2 };
  const filters = [...result.filters].sort(
    (a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9) || a.rank - b.rank,
  );

  let md = `# Search filters — ${name}\n\n`;
  md += `- **Saved:** ${new Date(savedAt).toLocaleString()}\n`;
  md += `- **Model:** ${model}\n`;
  if (result.subcat_name || result.subcat_id)
    md += `- **Subcategory:** ${result.subcat_name ?? ""}${result.subcat_id ? ` (${result.subcat_id})` : ""}\n`;
  if (result.mcat_id) md += `- **MCAT ID:** ${result.mcat_id}\n`;
  if (result.pmcat)
    md += `- **Primary PMCAT:** ${result.pmcat.name}${result.pmcat.id ? ` (${result.pmcat.id})` : ""}\n`;
  if (result.total_keywords_analyzed)
    md += `- **Keywords analysed:** ${result.total_keywords_analyzed}\n`;
  md += `- **Filters:** ${filters.length} (Tier 1: ${filters.filter((f) => f.tier === "Tier 1").length}, Tier 2: ${filters.filter((f) => f.tier === "Tier 2").length}, Tier 3: ${filters.filter((f) => f.tier === "Tier 3").length})\n`;
  if (device) md += `- **Preview view:** ${device}\n`;
  md += `\n## Recommended filters\n\n`;
  md += `| # | Tier | Filter | UI pattern | Values | Confidence | Why |\n|---|---|---|---|---|---|---|\n`;
  filters.forEach((f, i) => {
    md += `| ${i + 1} | ${f.tier} | ${mdCell(f.name)}${f.needs_new_isq ? " ⚠️" : ""} | ${mdCell(f.ui_pattern)} | ${mdCell(valuesWithConfidence(f).join(", "))} | ${f.confidence} | ${mdCell(f.rationale)} |\n`;
  });

  if (filters.some((f) => f.value_confidence?.length)) md += `\n_${VALUE_CONFIDENCE_RULE}_\n`;

  const numeric = filters.filter((f) => f.ranges?.length || f.dimensions);
  if (numeric.length) {
    md += `\n## Numeric ranges (lower – upper)\n\n`;
    for (const f of numeric) {
      const options = rangeLines(f)
        .map((l) => l.replace("  →  ", ": "))
        .join("; ");
      const note = f.dimensions?.note ? ` _(${f.dimensions.note})_` : "";
      md += `- **${f.name}** — ${filterRangeText(f)} · ${options}${note}\n`;
    }
  }

  const isq = filters.filter((f) => f.needs_new_isq);
  if (isq.length) {
    md += `\n## Needs a new listing field\n\n`;
    isq.forEach((f) => {
      md += `- **${f.name}** — ${f.isq_note || "Spec is not captured on listings today."}${f.ai_values?.length ? ` AI-suggested values: ${f.ai_values.join(", ")}.` : ""}\n`;
    });
  }
  if (result.interaction_rules?.length) {
    md += `\n## Interaction rules\n\n${result.interaction_rules.map((r) => `- ${r}`).join("\n")}\n`;
  }
  if (result.blockers?.length) {
    md += `\n## Blockers\n\n${result.blockers.map((b) => `- ${b}`).join("\n")}\n`;
  }

  if (extra) md += `\n${extra.trim()}\n`;

  md += `\n## Inputs used\n\n`;
  const any =
    sameInputsNote ||
    inputs.serp ||
    inputs.internal ||
    inputs.context ||
    inputs.specs ||
    inputs.products;
  if (sameInputsNote) md += `_${sameInputsNote}_\n\n`;
  else if (!any) md += `_No inputs were stored with this run._\n\n`;
  if (!sameInputsNote) {
    md += fence("1. Google SERP keywords", inputs.serp, "json");
    md += fence("2. Internal search keywords", inputs.internal, "json");
    md += fence("3. Category context document", inputs.context, "text");
    md += fence("4. Spec importance ranking", inputs.specs, "text");
    md += fence("5. Product listings", inputs.products, "json");
  }

  md += `## Raw result JSON\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`;
  return md;
}

/** Everything a Generate produced with a category context: both results and how similar they are. */
export function buildFullMarkdown(opts: {
  name: string;
  savedAt: string;
  model: string;
  result: FilterResult;
  withoutResult: FilterResult;
  comparison: ContextComparison;
  inputs: InputBundle;
  device?: string;
}) {
  const { withoutResult, comparison, ...rest } = opts;
  const withPart = buildMarkdown({
    ...rest,
    name: `${opts.name} — with context`,
    extra: comparisonMarkdown(comparison),
  });
  const withoutPart = buildMarkdown({
    ...rest,
    name: `${opts.name} — without context`,
    result: withoutResult,
    sameInputsNote: "Same inputs as the with-context run above, with the category context removed.",
  });
  return `${withPart}\n\n---\n\n${withoutPart}`;
}

export function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "filters"
  );
}
