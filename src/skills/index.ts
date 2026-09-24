/*
 * Skill registry. Every prompt the app sends is assembled from these markdown files:
 *   system prompt = base.md  +  the "## Prompt" section of each skill listed for that stage.
 * Edit a single .md file to change one layer's behaviour; the "View prompts" panel shows the result.
 */
import base from "./base.md?raw";
import s01 from "./01-parse-keyword-files.md?raw";
import s02 from "./02-derive-specs-from-keywords.md?raw";
import s03 from "./03-demand-aggregation.md?raw";
import s04 from "./04-parse-product-json.md?raw";
import s05 from "./05-listing-spec-profile.md?raw";
import s06 from "./06-context-and-ranking.md?raw";
import s07 from "./07-filter-design-brief.md?raw";
import s08 from "./08-scoring-and-tiering.md?raw";
import s09 from "./09-filter-options-and-ui.md?raw";
import s10 from "./10-rationale-and-output.md?raw";
import s11 from "./11-output-validation.md?raw";

export interface SkillDoc {
  id: string;
  file: string;
  title: string;
  markdown: string;
  prompt: string;
}

/** The text under "## Prompt", up to the next level-2 heading. HTML comments are dropped. */
export function promptSection(md: string): string {
  const lines = md.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+prompt\s*$/i.test(l.trim()));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

function doc(id: string, file: string, markdown: string): SkillDoc {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file;
  return { id, file, title, markdown, prompt: promptSection(markdown) };
}

export const SKILLS = {
  base: doc("base", "base.md", base),
  parseKeywords: doc("parseKeywords", "01-parse-keyword-files.md", s01),
  deriveSpecs: doc("deriveSpecs", "02-derive-specs-from-keywords.md", s02),
  aggregation: doc("aggregation", "03-demand-aggregation.md", s03),
  parseProducts: doc("parseProducts", "04-parse-product-json.md", s04),
  listingProfile: doc("listingProfile", "05-listing-spec-profile.md", s05),
  contextRanking: doc("contextRanking", "06-context-and-ranking.md", s06),
  designBrief: doc("designBrief", "07-filter-design-brief.md", s07),
  scoring: doc("scoring", "08-scoring-and-tiering.md", s08),
  options: doc("options", "09-filter-options-and-ui.md", s09),
  output: doc("output", "10-rationale-and-output.md", s10),
  validation: doc("validation", "11-output-validation.md", s11),
} satisfies Record<string, SkillDoc>;

export type SkillId = keyof typeof SKILLS;

export type StageId = "label" | "fields" | "design";

/** Which skill docs make up each stage's system prompt, in order (base.md is always first). */
export const STAGES: Record<StageId, { title: string; skills: SkillId[] }> = {
  label: { title: "Keyword term labelling", skills: ["deriveSpecs"] },
  fields: { title: "Listing field mapping", skills: ["parseProducts"] },
  design: {
    title: "Master prompt — filter design",
    skills: [
      "designBrief",
      "parseKeywords",
      "aggregation",
      "contextRanking",
      "listingProfile",
      "scoring",
      "options",
      "output",
    ],
  },
};

const DIVIDER = "\n\n═══════════════════════════════════════\n\n";

export function stageSkills(stage: StageId, exclude: SkillId[] = []): SkillDoc[] {
  return [
    SKILLS.base,
    ...STAGES[stage].skills.filter((id) => !exclude.includes(id)).map((id) => SKILLS[id]),
  ];
}

export function composeSystemPrompt(stage: StageId, exclude: SkillId[] = []): string {
  return stageSkills(stage, exclude)
    .map((s) => s.prompt)
    .filter(Boolean)
    .join(DIVIDER);
}
