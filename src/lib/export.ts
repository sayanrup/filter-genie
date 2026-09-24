import type { FilterResult } from "./filter-gen";

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

function fence(label: string, body: string, lang = "text") {
  if (!body.trim()) return "";
  return `### ${label}\n\n\`\`\`${lang}\n${body.slice(0, 20000)}\n\`\`\`\n\n`;
}

export function buildMarkdown(opts: {
  name: string;
  savedAt: string;
  model: string;
  result: FilterResult;
  inputs: InputBundle;
  device?: string;
}) {
  const { name, savedAt, model, result, inputs, device } = opts;
  const order: Record<string, number> = { "Tier 1": 0, "Tier 2": 1, "Tier 3": 2 };
  const filters = [...result.filters].sort(
    (a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9) || a.rank - b.rank,
  );

  let md = `# Search filters — ${name}\n\n`;
  md += `- **Saved:** ${new Date(savedAt).toLocaleString()}\n`;
  md += `- **Model:** ${model}\n`;
  if (result.total_keywords_analyzed)
    md += `- **Keywords analysed:** ${result.total_keywords_analyzed}\n`;
  md += `- **Filters:** ${filters.length} (Tier 1: ${filters.filter((f) => f.tier === "Tier 1").length}, Tier 2: ${filters.filter((f) => f.tier === "Tier 2").length}, Tier 3: ${filters.filter((f) => f.tier === "Tier 3").length})\n`;
  if (device) md += `- **Preview view:** ${device}\n`;
  md += `\n## Recommended filters\n\n`;
  md += `| # | Tier | Filter | UI pattern | Values | Confidence | Why |\n|---|---|---|---|---|---|---|\n`;
  filters.forEach((f, i) => {
    md += `| ${i + 1} | ${f.tier} | ${mdCell(f.name)}${f.needs_new_isq ? " ⚠️" : ""} | ${mdCell(f.ui_pattern)} | ${mdCell((f.values ?? []).join(", "))} | ${f.confidence} | ${mdCell(f.rationale)} |\n`;
  });

  const isq = filters.filter((f) => f.needs_new_isq);
  if (isq.length) {
    md += `\n## Needs a new listing field\n\n`;
    isq.forEach((f) => {
      md += `- **${f.name}** — ${f.isq_note || "Spec is not captured on listings today."}\n`;
    });
  }
  if (result.interaction_rules?.length) {
    md += `\n## Interaction rules\n\n${result.interaction_rules.map((r) => `- ${r}`).join("\n")}\n`;
  }
  if (result.blockers?.length) {
    md += `\n## Blockers\n\n${result.blockers.map((b) => `- ${b}`).join("\n")}\n`;
  }

  md += `\n## Inputs used\n\n`;
  const any = inputs.serp || inputs.internal || inputs.context || inputs.specs || inputs.products;
  if (!any) md += `_No inputs were stored with this run._\n\n`;
  md += fence("1. Google SERP keywords", inputs.serp, "json");
  md += fence("2. Internal search keywords", inputs.internal, "json");
  md += fence("3. Category context document", inputs.context, "text");
  md += fence("4. Spec importance ranking", inputs.specs, "text");
  md += fence("5. Product listings", inputs.products, "json");

  md += `## Raw result JSON\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`;
  return md;
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
