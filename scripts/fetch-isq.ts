/**
 * Pulls MCATs' live ISQs (the buyer-form spec questions and their options) from IndiaMART's getisq API
 * into one JSON file, plus a small one to upload to the app. The API only answers on the IndiaMART
 * network and needs an access token: GETISQ_TOKEN, from the environment or from .env.local (which is
 * gitignored; never put the token in code).
 *
 *   npx tsx scripts/fetch-isq.ts <list.txt | export.json | 35589 135705 …> [--out saved-results/isq.json]
 *                                [--upload <file>] [--parallel 4] [--force]
 *
 * The MCATs come as ids, or as files read by mcat-list.ts: the MCAT list copied from the app (which
 * also gives each MCAT's listings and PMCAT), a JSON with `mcats` (such as the app's "ISQs + confidence"
 * export), or one id per line.
 *
 * The full file (--out): `{generated_at, source, summary, mcats: [{mcat_id, mcat_name, pmcat, listings,
 * status, isq_count, isqs: [{id, name, type, priority, sort_order, options: [{id, value, priority}]}]}]}`,
 * in the order the MCATs were given. `status` is "ok", "no_isqs", "api_error" or "fetch_failed".
 *
 * The upload file (--upload; by default the --out name with "forupload" before ".json", so
 * subcat729isq.json → subcat729isqforupload.json) holds each MCAT's name, id, PMCAT and listings, and its
 * ISQs as `isqs: [{name, values}]`, one ISQ per line. It leaves out the buyer-form questions that aren't
 * product attributes (Quantity, Quantity Unit, I am interested in, Finance/Loan Requirement, Business Type),
 * inactive options, and ISQs with no options.
 *
 * The API joins an ISQ's options into one comma-separated string, and their ids the same way. A value with
 * a thousands or lakh comma ("5,000 sq ft", "1,00,000 sq ft") splits into extra pieces; they are joined
 * back until the count matches the ids. An ISQ where it still doesn't match is marked
 * `options_split_uncertain` and listed in the summary.
 *
 * An MCAT already in the file is skipped unless it failed, so a run that stopped partway picks up where it
 * left off (--force fetches every MCAT again). A request that can't connect or times out is tried 3 times.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readMcatList, type Wanted } from "./mcat-list";

const API = "http://leads.imutils.com/wservce/buyleads/getisq/";
const TRIES = 3;
const TIMEOUT_MS = 30_000;
/** The files are rewritten after this many MCATs, so a stopped run keeps what it had. */
const SAVE_EVERY = 20;
/** Questions every buyer form asks: not product attributes, so not in the upload file. */
const BUYER_FORM =
  /^(quantity|quantity unit|i am interested in|finance\s*\/?\s*loan requirement|business type)$/i;

interface Option {
  id: string;
  value: string;
  priority: number | null;
  active?: false;
}

interface Isq {
  id: string;
  name: string;
  type: string;
  priority: number | null;
  sort_order: number | null;
  name_with_affix?: string;
  active?: false;
  options: Option[];
  options_split_uncertain?: true;
}

interface McatIsqs {
  mcat_id: string;
  mcat_name: string | null;
  pmcat: string | null;
  listings?: number;
  status: "ok" | "no_isqs" | "api_error" | "fetch_failed";
  code?: string;
  message?: string;
  isq_count: number;
  isqs: Isq[];
}

type Row = Record<string, unknown>;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUE_FLAGS = new Set(["--out", "--upload", "--parallel"]);
const inputs = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1] ?? ""));
const out = flag("out") ?? "saved-results/isq.json";
const upload =
  flag("upload") ?? join(dirname(out), basename(out).replace(/(\.json)?$/i, "forupload.json"));
const parallel = Math.max(1, Number(flag("parallel")) || 4);
const force = args.includes("--force");

const wanted = readMcatList(inputs);
const seen = new Set(wanted.map((w) => w.id));
if (!wanted.length) {
  console.error(
    "Usage: npx tsx scripts/fetch-isq.ts <list.txt | export.json | id …> [--out saved-results/isq.json] [--upload <file>] [--parallel 4] [--force]",
  );
  process.exit(1);
}

if (!process.env["GETISQ_TOKEN"] && existsSync(".env.local")) process.loadEnvFile(".env.local");
const token = process.env["GETISQ_TOKEN"]?.trim();
if (!token) {
  console.error("Set GETISQ_TOKEN (in the environment, or as GETISQ_TOKEN=… in .env.local).");
  process.exit(1);
}

/** The API's token error stops the whole run: every other MCAT would fail the same way. */
class TokenError extends Error {}

const list = (s: unknown) => (s == null || s === "" ? [] : String(s).split(","));

/** The options of one ISQ row, with values cut at a thousands or lakh comma joined back together. */
function optionsOf(row: Row): { options: Option[]; uncertain: boolean } {
  const ids = list(row["IM_SPEC_OPTIONS_ID"]);
  const pieces = list(row["IM_SPEC_OPTIONS_DESC"]);
  for (let i = 0; pieces.length > ids.length && i < pieces.length - 1;) {
    const next = pieces[i + 1]!;
    if (/\d$/.test(pieces[i]!) && (/^\d{2}$/.test(next) || /^\d{3}(?!\d)/.test(next)))
      pieces.splice(i, 2, `${pieces[i]},${next}`);
    else i++;
  }
  const status = list(row["IM_SPEC_OPTIONS_STATUS"]);
  const priority = list(row["IM_SPEC_OPT_PRIORITY"]);
  const options = ids
    .map((id, i): Option => ({
      id,
      value: (pieces[i] ?? "").trim(),
      priority: Number(priority[i]) || null,
      ...(status[i] && status[i] !== "1" ? { active: false as const } : {}),
    }))
    // An option with no text (a leading "," in the list), or "None", is left out.
    .filter((o) => o.value && o.value.toLowerCase() !== "none");
  return { options, uncertain: pieces.length !== ids.length };
}

function isqOf(row: Row): Isq {
  const { options, uncertain } = optionsOf(row);
  const affix = String(row["IM_SPEC_DESC_WITH_AFFIX"] ?? "").trim();
  return {
    id: String(row["IM_SPEC_MASTER_ID"] ?? ""),
    name: String(row["IM_SPEC_MASTER_DESC"] ?? "").trim(),
    type: String(row["IM_SPEC_MASTER_TYPE"] ?? ""),
    priority: Number(row["IM_CAT_SPEC_PRIORITY"]) || null,
    sort_order: Number(row["IM_CAT_SPECIFICATION_SORTORDER"]) || null,
    ...(affix ? { name_with_affix: affix } : {}),
    ...(row["IM_SPEC_MASTER_STATUS"] !== "1" ? { active: false as const } : {}),
    options,
    ...(uncertain ? { options_split_uncertain: true as const } : {}),
  };
}

/** DATA is a list of ISQ rows; it can also be an object with numeric keys (and OLD_DATA, left out). */
function rowsOf(data: unknown): Row[] {
  if (Array.isArray(data)) return data as Row[];
  if (!data || typeof data !== "object") return [];
  return Object.entries(data)
    .filter(([k]) => k !== "OLD_DATA")
    .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
    .filter((r): r is Row => Boolean(r && typeof r === "object" && "IM_SPEC_MASTER_DESC" in r));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchOne(w: Wanted): Promise<McatIsqs> {
  const url = `${API}?${new URLSearchParams({ modid: "DIR", token: token!, mcatid: w.id, cat_type: "3" })}`;
  const head = {
    mcat_id: w.id,
    mcat_name: w.name ?? null,
    pmcat: w.pmcat ?? null,
    ...(w.listings != null ? { listings: w.listings } : {}),
  };
  let last: unknown;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const raw = (await resp.json()) as Row & { RESPONSE?: Row };
      // A bad token comes back wrapped in RESPONSE; everything else at the top level.
      const body = raw.RESPONSE ?? raw;
      const code = String(body["CODE"] ?? resp.status);
      const message = typeof body["MESSAGE"] === "string" ? body["MESSAGE"] : undefined;
      if (code === "401") throw new TokenError(`getisq API: ${message ?? "token refused"}`);
      if (resp.status >= 500) throw new Error(`getisq API answered ${resp.status}`);
      const isqs = rowsOf(body["DATA"]).map(isqOf);
      // "DATA NOT FOUND" (404) is an MCAT without ISQs, or an id the API doesn't know.
      const status =
        code === "200" || code === "404" ? (isqs.length ? "ok" : "no_isqs") : "api_error";
      return {
        ...head,
        status,
        code,
        ...(message ? { message } : {}),
        isq_count: isqs.length,
        isqs,
      };
    } catch (e) {
      if (e instanceof TokenError) throw e;
      last = e;
      if (attempt < TRIES) await sleep(attempt * 2000);
    }
  }
  return {
    ...head,
    status: "fetch_failed",
    message: String((last as Error)?.message ?? last),
    isq_count: 0,
    isqs: [],
  };
}

const byId = new Map<string, McatIsqs>();
if (!force && existsSync(out)) {
  const previous = JSON.parse(readFileSync(out, "utf8")) as { mcats?: McatIsqs[] };
  for (const m of previous.mcats ?? []) byId.set(m.mcat_id, m);
}

/** An MCAT cut to what the upload file holds: product ISQs with their active values. */
function forUpload(m: McatIsqs) {
  const isqs = m.isqs
    .filter((q) => q.active !== false && !BUYER_FORM.test(q.name))
    .map((q) => ({
      name: q.name,
      // In the form's own order: option priority 1 first.
      values: q.options
        .filter((o) => o.active !== false)
        .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
        .map((o) => o.value),
    }))
    .filter((q) => q.values.length);
  return {
    head: {
      mcat_name: m.mcat_name,
      mcat_id: m.mcat_id,
      ...(m.pmcat ? { pmcat: m.pmcat } : {}),
      ...(m.listings != null ? { listings: m.listings } : {}),
    },
    isqs,
  };
}

/** Entries for the MCATs asked for come first, in that order; anything else already in the file stays. */
function save() {
  const mcats = [
    ...wanted.flatMap((w) => byId.get(w.id) ?? []),
    ...[...byId.values()].filter((m) => !seen.has(m.mcat_id)),
  ];
  const full = {
    generated_at: new Date().toISOString(),
    source: `${API}?modid=DIR&cat_type=3&mcatid=<id>`,
    summary: {
      mcats: mcats.length,
      with_isqs: mcats.filter((m) => m.status === "ok").length,
      isqs_total: mcats.reduce((n, m) => n + m.isq_count, 0),
      no_isqs: mcats.filter((m) => m.status === "no_isqs").map((m) => label(m)),
      failed: mcats
        .filter((m) => m.status === "api_error" || m.status === "fetch_failed")
        .map((m) => `${label(m)}: ${m.message ?? m.code ?? m.status}`),
      options_split_uncertain: mcats.flatMap((m) =>
        m.isqs.filter((q) => q.options_split_uncertain).map((q) => `${label(m)}: ${q.name}`),
      ),
    },
    mcats,
  };
  const blocks = mcats
    .filter((m) => m.status === "ok")
    .map((m) => {
      const { head, isqs } = forUpload(m);
      const rows = isqs.map((q) => `    ${JSON.stringify(q)}`);
      return `  {${JSON.stringify(head).slice(1, -1)}, "isqs": [\n${rows.join(",\n")}\n  ]}`;
    });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(full, null, 2)}\n`);
  writeFileSync(upload, `[\n${blocks.join(",\n")}\n]\n`);
  return full.summary;
}

const label = (m: { mcat_id: string; mcat_name: string | null }) =>
  m.mcat_name ? `${m.mcat_name} (${m.mcat_id})` : m.mcat_id;

const todo = wanted.filter((w) => {
  const had = byId.get(w.id);
  return !had || had.status === "api_error" || had.status === "fetch_failed";
});
console.log(
  `${wanted.length} MCATs: ${wanted.length - todo.length} already in ${out}, fetching ${todo.length} (${parallel} at a time)`,
);

let next = 0;
let done = 0;
const worker = async () => {
  for (let i = next++; i < todo.length; i = next++) {
    const w = todo[i]!;
    const m = await fetchOne(w);
    byId.set(w.id, m);
    const result =
      m.status === "ok"
        ? `${m.isq_count} ISQs`
        : m.status === "no_isqs"
          ? "no ISQs"
          : `FAILED: ${m.message ?? m.code}`;
    console.log(
      `[${++done}/${todo.length}] ${label({ mcat_id: w.id, mcat_name: w.name ?? null })} — ${result}`,
    );
    if (done % SAVE_EVERY === 0) save();
  }
};
try {
  await Promise.all(Array.from({ length: Math.min(parallel, todo.length) }, worker));
} catch (e) {
  if (!(e instanceof TokenError)) throw e;
  save();
  console.error(`${e.message}. Check GETISQ_TOKEN; nothing more was fetched.`);
  process.exit(1);
}

const summary = save();
console.log(
  `Saved ${summary.with_isqs} of ${wanted.length} MCATs with ISQs (${summary.isqs_total} ISQs) → ${out} (full), ${upload} (for upload)`,
);
if (summary.no_isqs.length) console.log(`No ISQs: ${summary.no_isqs.join(", ")}`);
if (summary.options_split_uncertain.length)
  console.log(`Values to check (split uncertain): ${summary.options_split_uncertain.join("; ")}`);
if (summary.failed.length) {
  console.error(`Failed (run again to retry them):\n  ${summary.failed.join("\n  ")}`);
  process.exitCode = 1;
}
