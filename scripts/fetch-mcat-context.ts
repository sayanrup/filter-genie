/**
 * Pulls a subcategory's MCATs from IndiaMART's context API and saves all their Seller & Buyer Spec
 * Audits into one JSON file, plus a small one to upload to the app. The API only answers on the
 * IndiaMART network.
 *
 *   npx tsx scripts/fetch-mcat-context.ts <ids.txt | 35589 135705 …> [--out saved-results/mcat-context.json]
 *                                         [--upload <file>] [--parallel 4] [--force]
 *
 * The MCATs come as ids, or as files read by mcat-list.ts: the MCAT list copied from the app (which
 * also gives each MCAT's listings and PMCAT), a JSON with `mcats`, or one id per line.
 *
 * The file is an array with one entry per MCAT, in the order the ids were given: its name, ids,
 * PMCAT and listings, then the audit's tables (`buyer_attracting_seller_specs` is its ISQs and
 * their values).
 *
 * The upload file (--upload; by default the --out name with "context" made "forupload", so
 * subcat729mcatcontext.json → subcat729mcatforupload.json) holds only what the app reads from the
 * category document in input 3: each MCAT's name, id, PMCAT and listings, and its ISQs with their
 * values under `isq`. One ISQ per line.
 *
 * An MCAT already in the file is skipped, so a run that stopped partway picks up where it left off
 * (--force fetches it again). A request that can't connect or times out is tried 3 times.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { McatApiError, fetchMcatContext, type Json } from "../src/lib/mcat-context";
import { readMcatList, type Wanted } from "./mcat-list";

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
const VALUE_FLAGS = new Set(["--out", "--upload", "--parallel"]);
const inputs = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1] ?? ""));
const out = flag("out") ?? "saved-results/mcat-context.json";
const upload =
  flag("upload") ??
  join(
    dirname(out),
    /context/i.test(basename(out))
      ? basename(out).replace(/context(?!.*context)/i, "forupload")
      : basename(out).replace(/(\.json)?$/i, "-for-upload.json"),
  );
const parallel = Math.max(1, Number(flag("parallel")) || 4);
const force = args.includes("--force");

const wanted = readMcatList(inputs);
const seen = new Set(wanted.map((w) => w.id));
if (!wanted.length) {
  console.error(
    "Usage: npx tsx scripts/fetch-mcat-context.ts <ids.txt | id …> [--out saved-results/mcat-context.json] [--upload <file>] [--parallel 4] [--force]",
  );
  process.exit(1);
}

const byId = new Map<string, Entry>();
if (!force && existsSync(out))
  for (const e of JSON.parse(readFileSync(out, "utf8")) as Entry[])
    if (typeof e["mcat_id"] === "string") byId.set(e["mcat_id"], e);

/** An entry cut to what the app reads: its name, id, PMCAT and listings, and its ISQs. */
const forUpload = (e: Entry): Entry => ({
  mcat_name: e["mcat_name"] ?? null,
  mcat_id: e["mcat_id"] ?? null,
  ...(e["pmcat"] != null ? { pmcat: e["pmcat"] } : {}),
  ...(e["listings"] != null ? { listings: e["listings"] } : {}),
  isq: e["buyer_attracting_seller_specs"] ?? [],
});

/** One MCAT per block and one ISQ per line: small, and still easy to read. */
function uploadJson(entries: Entry[]): string {
  const blocks = entries.map((e) => {
    const { isq, ...head } = forUpload(e);
    const rows = (Array.isArray(isq) ? isq : []).map((r) => `    ${JSON.stringify(r)}`);
    return `  {${JSON.stringify(head).slice(1, -1)}, "isq": [\n${rows.join(",\n")}\n  ]}`;
  });
  return `[\n${blocks.join(",\n")}\n]\n`;
}

/** Entries for the ids asked for come first, in that order; anything else already in the file stays. */
function save() {
  const asked = wanted.flatMap((w) => byId.get(w.id) ?? []);
  const rest = [...byId.values()].filter((e) => !seen.has(String(e["mcat_id"])));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify([...asked, ...rest], null, 2)}\n`);
  writeFileSync(upload, uploadJson([...asked, ...rest]));
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

console.log(
  `Saved ${wanted.length - failed.length} of ${wanted.length} MCATs → ${out} (full), ${upload} (for upload)`,
);
if (failed.length) {
  console.error(
    `${failed.length} didn't load (run again to retry them):\n  ${failed.join("\n  ")}`,
  );
  process.exitCode = 1;
}
