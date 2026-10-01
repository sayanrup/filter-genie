/**
 * Adds saved-result .md downloads (the app's "Save everything" files) to the results everyone sees
 * under "View saved results".
 *
 *   npx tsx scripts/import-published-md.ts <file.md> [more.md ...]
 *
 * Reads the two "Raw result JSON" blocks (with context, then without) and the comparison section,
 * and appends one entry per file to src/data/published-results.json. A category that is already
 * published (same name) is skipped. Commit the JSON file to publish it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { compareContext, type ContextComparison, type RefCoverage } from "../src/lib/compare";
import type { FilterResult } from "../src/lib/filter-gen";

const OUT = "src/data/published-results.json";

function jsonBlocks(md: string): FilterResult[] {
  const out: FilterResult[] = [];
  const re = /## Raw result JSON\s+```json\n([\s\S]*?)\n```/g;
  for (let m = re.exec(md); m; m = re.exec(md)) out.push(JSON.parse(m[1]!) as FilterResult);
  return out;
}

const names = (line: string | undefined) =>
  !line || /^none$/i.test(line.trim())
    ? []
    : line
        .split(/,\s+/)
        .map((s) => s.trim())
        .filter(Boolean);

/** "**Against the ISQs you gave, with context:** 3/15 found" plus its Missed / Extra lines. */
function refCoverage(md: string, label: "with" | "without"): RefCoverage | null {
  const lines = md.split("\n");
  const at = lines.findIndex(
    (l) => l.startsWith("**Against the ISQs you gave") && l.includes(`, ${label} context:`),
  );
  if (at < 0) return null;
  const found = lines[at]!.match(/(\d+)\/(\d+) found/);
  if (!found) return null;
  const after = (prefix: string) =>
    lines
      .slice(at + 1, at + 4)
      .find((l) => l.startsWith(prefix))
      ?.slice(prefix.length);
  return {
    reference: Number(found[2]),
    // The names of the matched ISQs aren't in the .md; only their count is used on screen.
    covered: Array.from({ length: Number(found[1]) }, (_, i) => `(matched ${i + 1})`),
    missed: names(after("- Missed: ")),
    extra: names(after("- Extra: ")),
  };
}

const files = process.argv.slice(2).filter((a) => /\.md$/i.test(a));
if (!files.length) {
  console.error("Usage: npx tsx scripts/import-published-md.ts <file.md> [more.md ...]");
  process.exit(1);
}

const list = JSON.parse(readFileSync(OUT, "utf8")) as { name: string }[];
let added = 0;
for (const file of files) {
  const md = readFileSync(file, "utf8");
  const [withCtx, without] = jsonBlocks(md);
  if (!withCtx) {
    console.warn(`skip ${basename(file)}: no "Raw result JSON" block`);
    continue;
  }
  const name = withCtx.category_name || basename(file).replace(/-\d{4}-\d{2}-\d{2}.*$/, "");
  if (list.some((e) => e.name === name)) {
    console.warn(`skip ${basename(file)}: "${name}" is already published`);
    continue;
  }
  const model = md.match(/^- \*\*Model:\*\* (.*)$/m)?.[1]?.trim() ?? "imported";
  let comparison: ContextComparison | undefined;
  if (without) {
    comparison = compareContext(without, withCtx, []);
    comparison.refWith = refCoverage(md, "with");
    comparison.refWithout = refCoverage(md, "without");
  }
  const now = new Date();
  list.unshift({
    id: `published-${now.getTime()}-${added}`,
    name,
    savedAt: now.toISOString(),
    model,
    result: withCtx,
    inputs: { serp: "", internal: "", context: "", specs: "", products: "" },
    ...(without && comparison ? { withoutResult: without, comparison } : {}),
  } as never);
  added++;
  console.log(
    `+ ${name}: ${withCtx.filters.length} filters${without ? ` / ${without.filters.length} without context, overlap ${comparison!.overlapPct}%` : ""}`,
  );
}
writeFileSync(OUT, `${JSON.stringify(list, null, 2)}\n`);
console.log(`${added} added → ${OUT}`);
