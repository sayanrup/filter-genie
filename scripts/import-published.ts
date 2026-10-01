/**
 * Adds an Excel export ("Download .xlsx") to the results everyone sees under "View saved results".
 *
 *   npx tsx scripts/import-published.ts <file.xlsx> [--name "Category name"] [--model "gemini-…"]
 *
 * Appends to src/data/published-results.json (commit that file to publish it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import * as XLSX from "xlsx";
import { parseWorkbook } from "../src/lib/import-xlsx";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && /\.xlsx?$/i.test(a));
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!file) {
  console.error(
    'Usage: npx tsx scripts/import-published.ts <file.xlsx> [--name "…"] [--model "…"]',
  );
  process.exit(1);
}

const OUT = "src/data/published-results.json";
const wb = XLSX.read(readFileSync(file), { type: "buffer" });
const parsed = parseWorkbook(wb);

const base = basename(file, extname(file)).replace(/-\d{4}-\d{2}-\d{2}$/, "");
const name =
  flag("name") ??
  parsed.result.category_name ??
  base.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const savedAt = new Date().toISOString();
const entry = {
  id: `published-${Date.now()}`,
  name,
  savedAt,
  model: flag("model") ?? "imported from Excel",
  result: { ...parsed.result, category_name: name },
  inputs: { serp: "", internal: "", context: "", specs: "", products: "" },
  ...(parsed.withoutResult ? { withoutResult: parsed.withoutResult } : {}),
  ...(parsed.comparison ? { comparison: parsed.comparison } : {}),
};

const list = JSON.parse(readFileSync(OUT, "utf8")) as unknown[];
list.unshift(entry);
writeFileSync(OUT, `${JSON.stringify(list, null, 2)}\n`);
console.log(
  `Added "${name}" (${entry.result.filters.length} filters${parsed.withoutResult ? `, ${parsed.withoutResult.filters.length} without context` : ""}) → ${OUT}`,
);
