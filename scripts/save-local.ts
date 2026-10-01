/**
 * Files a downloaded result into a folder on this machine, rebuilt from the full data so nothing in
 * it is cut or lost (per-value confidence, ISQ links, inputs).
 *
 *   npx tsx scripts/save-local.ts <file.json|file.xlsx> [--dir saved-results] [--name "Category name"]
 *
 * From the app's "Save results" you get a .json (everything), an .xlsx and an .md. Give this the
 * .json: it writes  <dir>/<category>-<date>/  with
 *   result.json     the whole saved run (results + inputs)
 *   filters.xlsx    the filter table, values with their confidence ("House (High)")
 *   filters.md      the same as markdown, with the inputs used
 * An .xlsx works too, but it has no inputs. A folder with the same name is overwritten.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import * as XLSX from "xlsx";
import { buildMarkdown, slugify, type InputBundle } from "../src/lib/export";
import { buildWorkbook } from "../src/lib/export-xlsx";
import { parseWorkbook } from "../src/lib/import-xlsx";
import type { FilterResult } from "../src/lib/filter-gen";

interface Run {
  name: string;
  savedAt: string;
  model: string;
  result: FilterResult;
  inputs?: InputBundle;
  device?: string;
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!file || !/\.(json|xlsx?)$/i.test(file)) {
  console.error(
    'Usage: npx tsx scripts/save-local.ts <file.json|file.xlsx> [--dir saved-results] [--name "…"]',
  );
  process.exit(1);
}

function load(path: string): Run {
  if (/\.json$/i.test(path)) {
    const run = JSON.parse(readFileSync(path, "utf8")) as Run;
    if (!run?.result?.filters)
      throw new Error("This JSON has no result.filters — is it a saved run?");
    return run;
  }
  const { result } = parseWorkbook(XLSX.read(readFileSync(path), { type: "buffer" }));
  return {
    name: result.category_name || basename(path, extname(path)).replace(/-\d{4}-\d{2}-\d{2}$/, ""),
    savedAt: new Date().toISOString(),
    model: "imported from Excel",
    result,
  };
}

const run = load(file);
const name = flag("name") ?? run.name ?? "Untitled category";
const folder = join(flag("dir") ?? "saved-results", `${slugify(name)}-${run.savedAt.slice(0, 10)}`);
mkdirSync(folder, { recursive: true });

const inputs: InputBundle = run.inputs ?? {
  serp: "",
  internal: "",
  context: "",
  specs: "",
  products: "",
};
writeFileSync(join(folder, "result.json"), `${JSON.stringify({ ...run, name }, null, 2)}\n`);
XLSX.writeFile(buildWorkbook({ result: run.result }), join(folder, "filters.xlsx"));
writeFileSync(
  join(folder, "filters.md"),
  buildMarkdown({
    name,
    savedAt: run.savedAt,
    model: run.model,
    result: run.result,
    inputs,
    ...(run.device ? { device: run.device } : {}),
  }),
);

const withConfidence = run.result.filters.filter((f) => f.value_confidence?.length).length;
console.log(
  `Saved "${name}": ${run.result.filters.length} filters (${withConfidence} with value confidence) → ${folder}/`,
);
