/**
 * Pulls a subcategory's MCATs from IndiaMART's context API and saves all their Seller & Buyer Spec
 * Audits into one JSON file. The API only answers on the IndiaMART network.
 *
 *   npx tsx scripts/fetch-mcat-context.ts <ids.txt | 35589 135705 …> [--out saved-results/mcat-context.json]
 *                                         [--parallel 4] [--force]
 *
 * The ids file has one MCAT id per line (or in the first column of a CSV), or is the MCAT list copied
 * from the app, which also gives each MCAT's listings and PMCAT:
 *   Prefabricated Buildings
 *   MCAT ID 35589
 *   32 listings
 *   PMCAT Prefabricated Buildings
 *
 * The file is an array with one entry per MCAT, in the order the ids were given: its name, ids,
 * PMCAT and listings, then the audit's tables (`buyer_attracting_seller_specs` is its ISQs and
 * their values).
 *
 * An MCAT already in the file is skipped, so a run that stopped partway picks up where it left off
 * (--force fetches it again). A request that can't connect or times out is tried 3 times.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { McatApiError, fetchMcatContext, type Json } from "../src/lib/mcat-context";

interface Wanted {
  id: string;
  name?: string;
  listings?: number;
  pmcat?: string;
}

type Entry = { [key: string]: Json };

const TRIES = 3;
const TIMEOUT_MS = 60_000;
/** The file is rewritten after this many MCATs, so a stopped run keeps what it had. */
const SAVE_EVERY = 20;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUE_FLAGS = new Set(["--out", "--parallel"]);
const inputs = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1] ?? ""));
const out = flag("out") ?? "saved-results/mcat-context.json";
const parallel = Math.max(1, Number(flag("parallel")) || 4);
const force = args.includes("--force");

/** MCAT ids out of a file's text: the app's MCAT list ("MCAT ID 35589"), or one id per line. */
function parseIds(text: string): Wanted[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (!lines.some((l) => /^MCAT ID\s*\d+$/i.test(l)))
    return lines
      .map((l) => l.split(/[,;\t]/)[0]!.trim())
      .filter((cell) => /^\d+$/.test(cell))
      .map((id) => ({ id }));

  const found: Wanted[] = [];
  lines.forEach((line, i) => {
    const id = line.match(/^MCAT ID\s*(\d+)$/i)?.[1];
    if (!id) return;
    const entry: Wanted = { id };
    if (lines[i - 1]) entry.name = lines[i - 1]!;
    for (const next of lines.slice(i + 1, i + 3)) {
      const listings = next.match(/^(\d+) listings?$/i)?.[1];
      const pmcat = next.match(/^PMCAT\s+(.+)$/i)?.[1];
      if (listings) entry.listings = Number(listings);
      if (pmcat) entry.pmcat = pmcat;
    }
    found.push(entry);
  });
  return found;
}

const seen = new Set<string>();
const wanted = inputs
  .flatMap((a) => (/^\d+$/.test(a) ? [{ id: a }] : parseIds(readFileSync(a, "utf8"))))
  .filter((w) => !seen.has(w.id) && seen.add(w.id));
if (!wanted.length) {
  console.error(
    "Usage: npx tsx scripts/fetch-mcat-context.ts <ids.txt | id …> [--out saved-results/mcat-context.json] [--parallel 4] [--force]",
  );
  process.exit(1);
}

const byId = new Map<string, Entry>();
if (!force && existsSync(out))
  for (const e of JSON.parse(readFileSync(out, "utf8")) as Entry[])
    if (typeof e["mcat_id"] === "string") byId.set(e["mcat_id"], e);

/** Entries for the ids asked for come first, in that order; anything else already in the file stays. */
function save() {
  const asked = wanted.flatMap((w) => byId.get(w.id) ?? []);
  const rest = [...byId.values()].filter((e) => !seen.has(String(e["mcat_id"])));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify([...asked, ...rest], null, 2)}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchOne(w: Wanted): Promise<Entry> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { audit } = await fetchMcatContext(w.id, AbortSignal.timeout(TIMEOUT_MS));
      const { mcat_id, subcat_id, mcat_name, ...sections } = audit;
      return {
        mcat_name: mcat_name ?? w.name ?? null,
        mcat_id,
        subcat_id,
        ...(w.pmcat ? { pmcat: w.pmcat } : {}),
        ...(w.listings != null ? { listings: w.listings } : {}),
        ...sections,
      };
    } catch (e) {
      if (e instanceof McatApiError || attempt === TRIES) throw e;
      await sleep(attempt * 2000);
    }
  }
}

const todo = wanted.filter((w) => !byId.has(w.id));
const failed: string[] = [];
console.log(
  `${wanted.length} MCATs: ${wanted.length - todo.length} already in ${out}, fetching ${todo.length} (${parallel} at a time)`,
);

let next = 0;
let done = 0;
const worker = async () => {
  for (let i = next++; i < todo.length; i = next++) {
    const w = todo[i]!;
    let error = "";
    try {
      byId.set(w.id, await fetchOne(w));
    } catch (e) {
      error = (e as Error).message;
      failed.push(`${w.id}${w.name ? ` ${w.name}` : ""}: ${error}`);
    }
    const label = `[${++done}/${todo.length}] ${w.id}${w.name ? ` ${w.name}` : ""}`;
    console.log(error ? `${label} — FAILED: ${error}` : label);
    if (done % SAVE_EVERY === 0) save();
  }
};
await Promise.all(Array.from({ length: Math.min(parallel, todo.length) }, worker));
save();

console.log(`Saved ${wanted.length - failed.length} of ${wanted.length} MCATs → ${out}`);
if (failed.length) {
  console.error(
    `${failed.length} didn't load (run again to retry them):\n  ${failed.join("\n  ")}`,
  );
  process.exitCode = 1;
}
