import * as XLSX from "xlsx";

/*
 * Deterministic data preparation. Everything here runs in the browser without the
 * model: parsing uploads/pastes, detecting keyword and metric columns, mining the
 * keyword terms, adding up demand per filter value, and profiling listing specs.
 * The model is only asked to label and to judge — never to do arithmetic.
 */

export type Row = Record<string, unknown>;

export const MAX_ROWS = 5000;

// ───────────────────────────── parsing ─────────────────────────────

export function parseNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[₹$€£,\s]/g, "")
    .replace(/^(rs\.?|inr)/i, "")
    .replace(/%$/, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isEmpty(v: unknown) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  return (
    s === "" ||
    s === "-" ||
    s === "na" ||
    s === "n/a" ||
    s === "null" ||
    s === "undefined" ||
    s === "none"
  );
}

function findRecordArray(obj: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== "object" || depth > 2) return null;
  const rec = obj as Record<string, unknown>;
  for (const k of [
    "products",
    "items",
    "data",
    "listings",
    "results",
    "rows",
    "records",
    "keywords",
    "queries",
  ]) {
    if (Array.isArray(rec[k])) return rec[k] as unknown[];
  }
  // {"group-a": [...], "group-b": [...]} — e.g. one array per category: take them all, tagged by group.
  const groups = Object.entries(rec).filter(
    ([, v]) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object"),
  );
  if (groups.length >= 2) {
    return groups.flatMap(([group, v]) =>
      (v as Record<string, unknown>[]).map((item) => ({ _group: group, ...item })),
    );
  }
  for (const v of Object.values(rec)) {
    const found = findRecordArray(v, depth + 1);
    if (found && found.length > 0) return found;
  }
  return null;
}

function jsonToRows(text: string): Row[] {
  const parsed = JSON.parse(text);
  const items = findRecordArray(parsed) ?? [parsed];
  return items.map((it) => (it && typeof it === "object" ? (it as Row) : { query: String(it) }));
}

/** Char-level delimited-text parser (quotes, escaped quotes, CRLF). */
function parseDelimited(text: string, delim: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"' && cell === "") inQuotes = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) out.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) out.push(row);
  return out;
}

function detectDelimiter(firstLine: string): string | null {
  if (firstLine.includes("\t")) return "\t";
  const unquoted = firstLine.replace(/"[^"]*"/g, "");
  let best: string | null = null;
  let bestCount = 0;
  for (const d of [",", ";", "|"]) {
    const n = unquoted.split(d).length - 1;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

const HEADER_HINT =
  /quer|keyword|search|term|\bkw\b|click|impression|position|ctr|page ?view|enquir|inquir|lead|call|convers|volume|name|title|price|spec|material|size/i;

/** Parse pasted text: JSON, CSV, TSV, semicolon/pipe separated, or a plain list of keywords. */
export function textToRows(text: string): Row[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      return jsonToRows(t).slice(0, MAX_ROWS);
    } catch {
      /* fall through to delimited parsing */
    }
  }
  const firstLine = t.split(/\r?\n/, 1)[0] ?? "";
  const delim = detectDelimiter(firstLine);
  const table = delim ? parseDelimited(t, delim) : t.split(/\r?\n/).map((l) => [l]);
  if (table.length === 0) return [];

  const first = table[0]!;
  const second = table[1];
  const looksLikeHeader =
    first.some((c) => HEADER_HINT.test(c)) ||
    (first.every((c) => parseNum(c) === null) &&
      !!second &&
      second.some((c) => parseNum(c) !== null));

  const width = Math.max(...table.map((r) => r.length));
  const headers = looksLikeHeader
    ? Array.from({ length: width }, (_, i) => first[i]?.trim() || `col${i + 1}`)
    : Array.from({ length: width }, (_, i) => (i === 0 ? "query" : `col${i + 1}`));
  const body = looksLikeHeader ? table.slice(1) : table;

  return body.slice(0, MAX_ROWS).map((cells) => {
    const r: Row = {};
    headers.forEach((h, i) => {
      r[h] = cells[i]?.trim() ?? "";
    });
    return r;
  });
}

export async function fileToRows(file: File, limit = MAX_ROWS): Promise<Row[]> {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "json") return jsonToRows(await file.text()).slice(0, limit);
  if (ext === "txt" || ext === "tsv" || ext === "md")
    return textToRows(await file.text()).slice(0, limit);
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("This spreadsheet has no sheets.");
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error("Could not read the first sheet.");
  return (XLSX.utils.sheet_to_json(sheet) as Row[]).slice(0, limit);
}

// ───────────────────────────── keyword tables ─────────────────────────────

export type KeywordSource = "internal" | "serp";

export const SOURCE_LABEL: Record<KeywordSource, string> = {
  internal: "Internal search",
  serp: "Google SERP",
};

export interface KeywordRow {
  query: string;
  tokens: string[];
  demand: number;
  action: number;
  rates: Record<string, number>;
}

export interface KeywordTable {
  source: KeywordSource;
  queryColumn: string | null;
  demandMetric: string | null;
  actionMetric: string | null;
  rateMetrics: string[];
  rows: KeywordRow[];
  totalDemand: number;
  totalAction: number;
}

interface ColumnInfo {
  name: string;
  numeric: boolean;
  rate: boolean;
}

// Word-bounded so count columns like "Enquiries Generated" or "Times searched" aren't taken for rates.
const RATE_NAME =
  /%|\b(ctr|rate|ratio|avg|average|position|pos|rank|share|bounce|duration|percent(age)?)\b/i;

function describeColumns(rows: Row[]): ColumnInfo[] {
  const sample = rows.slice(0, 300);
  const keys: string[] = [];
  for (const r of sample) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  return keys.map((name) => {
    const vals = sample.map((r) => r[name]).filter((v) => !isEmpty(v));
    const nums = vals.map(parseNum).filter((n): n is number => n !== null);
    const numeric = vals.length > 0 && nums.length / vals.length >= 0.6;
    const pctStrings = vals.some((v) => typeof v === "string" && v.trim().endsWith("%"));
    const fractional =
      nums.length > 0 && nums.every((n) => n >= 0 && n <= 1) && nums.some((n) => n % 1 !== 0);
    return { name, numeric, rate: numeric && (RATE_NAME.test(name) || pctStrings || fractional) };
  });
}

function pickColumn(cols: ColumnInfo[], patterns: RegExp[], exclude: Set<string>): string | null {
  for (const p of patterns) {
    const hit = cols.find((c) => c.numeric && !c.rate && !exclude.has(c.name) && p.test(c.name));
    if (hit) return hit.name;
  }
  return null;
}

const DEMAND_PATTERNS: Record<KeywordSource, RegExp[]> = {
  internal: [
    /page ?views?|\bpvs?\b/i,
    /search(es)?\b|volume|frequency|\bcount\b/i,
    /sessions|visits|users/i,
    /impressions?/i,
    /clicks?/i,
  ],
  serp: [/clicks?/i, /impressions?/i, /volume|searches/i],
};

const ACTION_PATTERNS = [
  /approved|qualified/i,
  /enquir|inquir/i,
  /\bleads?\b|\bbl\b/i,
  /calls?\b/i,
  /cta/i,
  /conversions?|orders?|purchases?|contacts?/i,
];

// Words that glue a query together but never carry a filterable meaning.
const STOPWORDS = new Set(
  "a an the and or of in on at to for from with without by is are what which how where who me my your our i".split(
    " ",
  ),
);

/** Lower-case, normalise units/dimensions/currency so size and price signals become single tokens. */
export function normalizeQuery(q: string): string {
  let s = ` ${q.toLowerCase()} `;
  s = s.replace(/₹/g, " rs ");
  s = s.replace(/\bnear\s+(by\s+)?me\b/g, " near-me ");
  s = s.replace(/\bsq(uare)?\.?\s*(ft|feet|foot)\b/g, "sqft");
  s = s.replace(/\bsq(uare)?\.?\s*(m|mtr|meter|metre)s?\b/g, "sqm");
  s = s.replace(
    /(\d+(?:\.\d+)?)\s*(?:x|\*|×|by)\s*(\d+(?:\.\d+)?)(?:\s*(?:x|\*|×|by)\s*(\d+(?:\.\d+)?))?/g,
    (_m, a, b, c) => (c ? `${a}x${b}x${c}` : `${a}x${b}`),
  );
  s = s.replace(
    /(\d+(?:\.\d+)?)\s*(sqft|sqm|ft|feet|foot|mm|cm|inch|inches|mtr|meter|metre|m|kg|kgs|ton|tons|tonne|ltr|litre|liter|l|kl|kw|kva|hp|seater|seat|bhk|gsm|micron|watt|w|v|volt|amp|a|mah|gb|tb|rpm|bar|psi)\b/g,
    "$1$2",
  );
  s = s.replace(/[^a-z0-9.\-\s]/g, " ").replace(/(?<!\d)\.|\.(?!\d)/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

export function toKeywordTable(rows: Row[], source: KeywordSource): KeywordTable | null {
  if (rows.length === 0) return null;
  const cols = describeColumns(rows);
  const queryCol =
    cols.find((c) => !c.numeric && /quer|keyword|search|term|\bkw\b/i.test(c.name))?.name ??
    cols.find((c) => !c.numeric)?.name ??
    null;
  if (!queryCol) return null;

  const demandMetric =
    pickColumn(cols, DEMAND_PATTERNS[source], new Set()) ??
    cols.find((c) => c.numeric && !c.rate)?.name ??
    null;
  const actionMetric = pickColumn(
    cols,
    ACTION_PATTERNS,
    new Set(demandMetric ? [demandMetric] : []),
  );
  const rateMetrics = cols
    .filter(
      (c) =>
        c.rate &&
        /ctr|conv|enquir|inquir|lead|rate/i.test(c.name) &&
        !/position|rank/i.test(c.name),
    )
    .map((c) => c.name)
    .slice(0, 2);

  const merged = new Map<string, KeywordRow & { rateWeights: Record<string, number> }>();
  for (const r of rows) {
    const raw = String(r[queryCol] ?? "").trim();
    if (!raw) continue;
    const norm = normalizeQuery(raw);
    if (!norm) continue;
    const demand = demandMetric ? (parseNum(r[demandMetric]) ?? 0) : 1;
    const action = actionMetric ? (parseNum(r[actionMetric]) ?? 0) : 0;
    let row = merged.get(norm);
    if (!row) {
      row = {
        query: raw,
        tokens: norm.split(" "),
        demand: 0,
        action: 0,
        rates: {},
        rateWeights: {},
      };
      merged.set(norm, row);
    }
    row.demand += demand;
    row.action += action;
    for (const rm of rateMetrics) {
      let v = parseNum(r[rm]);
      if (v === null) continue;
      if (v <= 1 && !String(r[rm]).includes("%")) v *= 100; // store rates as percentages
      const w = Math.max(demand, 1);
      row.rates[rm] =
        ((row.rates[rm] ?? 0) * (row.rateWeights[rm] ?? 0) + v * w) /
        ((row.rateWeights[rm] ?? 0) + w);
      row.rateWeights[rm] = (row.rateWeights[rm] ?? 0) + w;
    }
  }

  const kwRows = [...merged.values()]
    .map(({ rateWeights: _rw, ...rest }) => rest)
    .sort((a, b) => b.demand - a.demand);
  return {
    source,
    queryColumn: queryCol,
    demandMetric,
    actionMetric,
    rateMetrics,
    rows: kwRows,
    totalDemand: kwRows.reduce((s, r) => s + r.demand, 0),
    totalAction: kwRows.reduce((s, r) => s + r.action, 0),
  };
}

export function describeKeywordTable(t: KeywordTable | null): string {
  if (!t) return "";
  const parts = [`${t.rows.length.toLocaleString()} unique keywords`, `query: “${t.queryColumn}”`];
  parts.push(
    t.demandMetric ? `demand: “${t.demandMetric}”` : "no demand metric — counting keywords",
  );
  if (t.actionMetric) parts.push(`action: “${t.actionMetric}”`);
  if (t.rateMetrics.length) parts.push(`rates: ${t.rateMetrics.map((r) => `“${r}”`).join(", ")}`);
  return parts.join(" · ");
}

// ───────────────────────────── term mining ─────────────────────────────

const SIZE_UNITS =
  "sqft|sqm|ft|feet|foot|mm|cm|inch|inches|mtr|meter|metre|m|kg|kgs|ton|tons|tonne|ltr|litre|liter|l|kl|kw|kva|hp|seater|seat|bhk|gsm|micron|watt|w|v|volt|amp|a|mah|gb|tb|rpm|bar|psi";
/** A dimension ("10x10", "20x8x8" with optional unit) or a number with a unit ("20ft", "1000l"). */
const SIZE_TOKEN = new RegExp(
  `^\\d+(\\.\\d+)?((x\\d+(\\.\\d+)?){1,2}(${SIZE_UNITS})?|(${SIZE_UNITS}))$`,
);
const PRICE_TOKEN =
  /^(price|prices|pricing|cost|costs|costing|rate|rates|cheap|cheapest|budget|rs|inr|lowest|affordable|quotation|quote|economical|low-cost|mrp)$/;

// Major Indian cities, states and regions (the marketplace context uses ₹ and ISQs).
const PLACES = new Set(
  (
    "delhi new-delhi ncr noida gurgaon gurugram faridabad ghaziabad mumbai navi-mumbai thane pune nagpur nashik aurangabad " +
    "bangalore bengaluru mysore mysuru hyderabad secunderabad chennai coimbatore madurai trichy salem kolkata howrah " +
    "ahmedabad surat vadodara baroda rajkot gandhinagar jaipur jodhpur udaipur kota ajmer lucknow kanpur agra varanasi " +
    "meerut allahabad prayagraj bhopal indore gwalior jabalpur raipur bilaspur patna ranchi jamshedpur dhanbad bhubaneswar " +
    "cuttack guwahati chandigarh mohali ludhiana amritsar jalandhar panipat sonipat karnal ambala dehradun haridwar " +
    "jammu srinagar shimla kochi cochin ernakulam trivandrum thiruvananthapuram kozhikode calicut visakhapatnam vizag " +
    "vijayawada guntur nellore tirupati warangal goa panaji mangalore mangaluru hubli belgaum siliguri durgapur asansol " +
    "maharashtra gujarat rajasthan punjab haryana karnataka kerala tamilnadu tamil-nadu telangana andhra bihar " +
    "jharkhand odisha orissa assam bengal uttarakhand himachal kashmir india near-me nearby local"
  ).split(" "),
);

export interface TermSourceStat {
  keywords: number;
  demand: number;
  action: number;
}

export interface TermStat {
  term: string;
  hint: "" | "size?" | "price?" | "location?";
  /** Set when code can label the term itself (price words, places, sizes) — it then skips the model. */
  auto: TermLabel | "skip" | null;
  example: string;
  bySource: Partial<Record<KeywordSource, TermSourceStat>>;
  score: number;
}

export interface TermMining {
  coreTerms: string[];
  terms: TermStat[];
  totalKeywords: number;
}

const PLACE_ALIASES: Record<string, string> = {
  bangalore: "Bengaluru",
  gurgaon: "Gurugram",
  "new-delhi": "Delhi",
  ncr: "Delhi NCR",
  "navi-mumbai": "Navi Mumbai",
  mysore: "Mysuru",
  mangalore: "Mangaluru",
  baroda: "Vadodara",
  allahabad: "Prayagraj",
  cochin: "Kochi",
  ernakulam: "Kochi",
  trivandrum: "Thiruvananthapuram",
  calicut: "Kozhikode",
  vizag: "Visakhapatnam",
  orissa: "Odisha",
  tamilnadu: "Tamil Nadu",
  "tamil-nadu": "Tamil Nadu",
  andhra: "Andhra Pradesh",
  bengal: "West Bengal",
  himachal: "Himachal Pradesh",
  "near-me": "Near me",
  nearby: "Near me",
  local: "Near me",
};

const UNIT_LABEL: Record<string, string> = {
  sqft: "sq ft",
  sqm: "sq m",
  ft: "ft",
  feet: "ft",
  foot: "ft",
  mm: "mm",
  cm: "cm",
  inch: "inch",
  inches: "inch",
  mtr: "m",
  meter: "m",
  metre: "m",
  m: "m",
  kg: "kg",
  kgs: "kg",
  ton: "ton",
  tons: "ton",
  tonne: "tonne",
  ltr: "L",
  litre: "L",
  liter: "L",
  l: "L",
  kl: "KL",
  kw: "kW",
  kva: "kVA",
  hp: "HP",
  seater: "seater",
  seat: "seater",
  bhk: "BHK",
  gsm: "GSM",
  micron: "micron",
  watt: "W",
  w: "W",
  v: "V",
  volt: "V",
  amp: "A",
  a: "A",
  mah: "mAh",
  gb: "GB",
  tb: "TB",
  rpm: "RPM",
  bar: "bar",
  psi: "psi",
};

const titleCase = (s: string) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** "20x10ft" → "20 x 10 ft", "1000l" → "1000 L". */
export function formatSize(token: string): string {
  const m = token.match(/^([\d.x]+?)([a-z]*)$/);
  if (!m) return token;
  const dims = m[1]!.split("x").join(" x ");
  const unit = m[2] ? (UNIT_LABEL[m[2]] ?? m[2]) : "";
  return unit ? `${dims} ${unit}` : dims;
}

/** Deterministic labels for single-token price words, places and sizes. */
function autoLabel(term: string): TermLabel | "skip" | null {
  if (term.includes(" ")) {
    // Phrases built on an auto-labelled word add nothing: the single word is counted on its own.
    return term.split(" ").some((t) => autoLabel(t) !== null) ? "skip" : null;
  }
  if (PRICE_TOKEN.test(term)) return { term, dimension: "Price", value: "Price intent" };
  if (term === "india") return "skip";
  if (PLACES.has(term))
    return { term, dimension: "Location", value: PLACE_ALIASES[term] ?? titleCase(term) };
  if (SIZE_TOKEN.test(term)) return { term, dimension: "Size / Capacity", value: formatSize(term) };
  return null;
}

function hintFor(term: string): TermStat["hint"] {
  if (term.split(" ").some((t) => SIZE_TOKEN.test(t))) return "size?";
  if (term.split(" ").some((t) => PRICE_TOKEN.test(t))) return "price?";
  if (term.split(" ").some((t) => PLACES.has(t))) return "location?";
  return "";
}

/** Merge simple plurals onto their singular when both forms occur (cabins → cabin, boxes → box). */
function pluralMap(tables: KeywordTable[]): Map<string, string> {
  const vocab = new Set<string>();
  for (const t of tables) for (const r of t.rows) for (const tok of r.tokens) vocab.add(tok);
  const map = new Map<string, string>();
  for (const tok of vocab) {
    if (tok.length <= 3 || /\d/.test(tok)) continue;
    if (tok.endsWith("es") && vocab.has(tok.slice(0, -2))) map.set(tok, tok.slice(0, -2));
    else if (tok.endsWith("s") && !tok.endsWith("ss") && vocab.has(tok.slice(0, -1)))
      map.set(tok, tok.slice(0, -1));
  }
  return map;
}

/** Tokens of a keyword after plural merging; stopwords stay in place so adjacency is preserved. */
function canonicalTokens(row: KeywordRow, plurals: Map<string, string>) {
  return row.tokens.map((t) => plurals.get(t) ?? t);
}

function isContent(tok: string) {
  return !STOPWORDS.has(tok) && !/^\d+(\.\d+)?$/.test(tok) && tok.length > 1;
}

/** Candidate terms of one keyword: content unigrams plus bigrams of two adjacent non-core content words. */
function termsOf(tokens: string[], core: Set<string>) {
  const out = new Set<string>();
  tokens.forEach((t, i) => {
    if (isContent(t) && !core.has(t)) out.add(t);
    const n = tokens[i + 1];
    if (n && isContent(t) && isContent(n) && !core.has(t) && !core.has(n)) out.add(`${t} ${n}`);
  });
  return out;
}

export function mineTerms(tables: KeywordTable[], maxTerms = 400): TermMining {
  const plurals = pluralMap(tables);
  const totalKeywords = tables.reduce((s, t) => s + t.rows.length, 0);

  // Core category words: present in a large share of all keywords.
  const df = new Map<string, number>();
  for (const t of tables)
    for (const r of t.rows)
      for (const tok of new Set(canonicalTokens(r, plurals)))
        if (isContent(tok)) df.set(tok, (df.get(tok) ?? 0) + 1);
  const ranked = [...df.entries()].sort((a, b) => b[1] - a[1]);
  // Words code labels itself (price, places, sizes) are qualifiers even when very frequent.
  const coreCandidates = ranked.filter(([t]) => autoLabel(t) === null);
  let core = coreCandidates
    .filter(([, n]) => n / Math.max(totalKeywords, 1) >= 0.4)
    .map(([t]) => t);
  const first = coreCandidates[0];
  if (core.length === 0 && first && first[1] / Math.max(totalKeywords, 1) >= 0.2) core = [first[0]];
  const coreSet = new Set(core);

  const stats = new Map<string, TermStat>();
  const exampleDemand = new Map<string, number>();
  for (const t of tables) {
    for (const r of t.rows) {
      for (const term of termsOf(canonicalTokens(r, plurals), coreSet)) {
        let st = stats.get(term);
        if (!st) {
          st = {
            term,
            hint: hintFor(term),
            auto: autoLabel(term),
            example: r.query,
            bySource: {},
            score: 0,
          };
          stats.set(term, st);
        }
        const s = (st.bySource[t.source] ??= { keywords: 0, demand: 0, action: 0 });
        s.keywords++;
        s.demand += r.demand;
        s.action += r.action;
        const share = t.totalDemand > 0 ? r.demand / t.totalDemand : 0;
        st.score += share + 1e-6; // keyword count breaks ties when demand is 0
        if ((exampleDemand.get(term) ?? -1) < r.demand) {
          exampleDemand.set(term, r.demand);
          st.example = r.query;
        }
      }
    }
  }

  const terms = [...stats.values()]
    .filter((st) => {
      if (st.auto === "skip") return false;
      if (st.auto) return true; // free: labelled by code
      const kws = Object.values(st.bySource).reduce((s, x) => s + (x?.keywords ?? 0), 0);
      // Phrases must recur; single words may pass on demand alone.
      return st.term.includes(" ") ? kws >= 2 : kws >= 2 || st.score >= 0.005;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTerms);

  return { coreTerms: core, terms, totalKeywords };
}

/** Terms the model still has to label, highest demand first, capped to keep the call cheap. */
export function termsForModel(mining: TermMining, cap = 150): TermStat[] {
  return mining.terms.filter((t) => !t.auto).slice(0, cap);
}

export function autoLabels(mining: TermMining): TermLabel[] {
  return mining.terms.map((t) => t.auto).filter((l): l is TermLabel => !!l && l !== "skip");
}

// ───────────────────────────── aggregation ─────────────────────────────

export interface TermLabel {
  term: string;
  dimension: string;
  value: string;
}

export interface BucketStat {
  keywords: number;
  demand: number;
  action: number;
  share: number; // % of the dimension's demand in this source
  rates: Record<string, number>;
}

export interface DimensionValue {
  value: string;
  bySource: Partial<Record<KeywordSource, BucketStat>>;
  score: number;
}

export interface DimensionSourceStat {
  keywords: number;
  demand: number;
  action: number;
  coverage: number; // % of the source's total demand whose keywords carry this dimension
  topShare: number; // % of the dimension's demand held by its largest value
}

export interface DimensionStats {
  name: string;
  values: DimensionValue[];
  bySource: Partial<Record<KeywordSource, DimensionSourceStat>>;
  score: number;
}

export interface Aggregation {
  dimensions: DimensionStats[];
  genericShare: Partial<Record<KeywordSource, number>>;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

export function aggregate(tables: KeywordTable[], labels: TermLabel[]): Aggregation {
  const plurals = pluralMap(tables);
  const map = new Map<string, TermLabel>();
  for (const l of labels) map.set(normalizeQuery(l.term), l);

  type Acc = {
    keywords: number;
    demand: number;
    action: number;
    rateSum: Record<string, number>;
    rateW: Record<string, number>;
  };
  const newAcc = (): Acc => ({ keywords: 0, demand: 0, action: 0, rateSum: {}, rateW: {} });
  const dimAcc = new Map<string, Map<KeywordSource, Acc>>();
  const valAcc = new Map<string, Map<string, Map<KeywordSource, Acc>>>();
  const generic: Partial<Record<KeywordSource, number>> = {};

  const add = (acc: Acc, r: KeywordRow) => {
    acc.keywords++;
    acc.demand += r.demand;
    acc.action += r.action;
    for (const [k, v] of Object.entries(r.rates)) {
      const w = Math.max(r.demand, 1);
      acc.rateSum[k] = (acc.rateSum[k] ?? 0) + v * w;
      acc.rateW[k] = (acc.rateW[k] ?? 0) + w;
    }
  };

  for (const t of tables) {
    let genericDemand = 0;
    for (const r of t.rows) {
      const toks = canonicalTokens(r, plurals);
      const used = new Array(toks.length).fill(false);
      const hits = new Map<string, Set<string>>();
      const hit = (l: TermLabel) => {
        if (!hits.has(l.dimension)) hits.set(l.dimension, new Set());
        hits.get(l.dimension)!.add(l.value);
      };
      // Longest match first: bigrams consume their tokens so "mild steel" isn't also counted as "steel".
      for (let i = 0; i < toks.length - 1; i++) {
        const l = map.get(`${toks[i]} ${toks[i + 1]}`);
        if (l && !used[i] && !used[i + 1]) {
          hit(l);
          used[i] = used[i + 1] = true;
        }
      }
      toks.forEach((tok, i) => {
        const l = map.get(tok);
        if (l && !used[i]) hit(l);
      });

      if (hits.size === 0) genericDemand += r.demand;
      for (const [dim, vals] of hits) {
        if (!dimAcc.has(dim)) dimAcc.set(dim, new Map());
        const da = dimAcc.get(dim)!;
        if (!da.has(t.source)) da.set(t.source, newAcc());
        add(da.get(t.source)!, r);
        if (!valAcc.has(dim)) valAcc.set(dim, new Map());
        for (const v of vals) {
          const vm = valAcc.get(dim)!;
          if (!vm.has(v)) vm.set(v, new Map());
          const sm = vm.get(v)!;
          if (!sm.has(t.source)) sm.set(t.source, newAcc());
          add(sm.get(t.source)!, r);
        }
      }
    }
    generic[t.source] = pct(genericDemand, t.totalDemand);
  }

  const totals = new Map(tables.map((t) => [t.source, t.totalDemand]));
  const dimensions: DimensionStats[] = [...dimAcc.entries()].map(([name, bySrc]) => {
    const values: DimensionValue[] = [
      ...(valAcc.get(name) ?? new Map<string, Map<KeywordSource, Acc>>()).entries(),
    ].map(([value, vs]) => {
      const bySource: DimensionValue["bySource"] = {};
      let score = 0;
      for (const [src, acc] of vs) {
        const dimDemand = bySrc.get(src)?.demand ?? 0;
        const rates: Record<string, number> = {};
        for (const k of Object.keys(acc.rateSum))
          rates[k] = Math.round((acc.rateSum[k]! / acc.rateW[k]!) * 10) / 10;
        bySource[src] = {
          keywords: acc.keywords,
          demand: acc.demand,
          action: acc.action,
          share: pct(acc.demand, dimDemand),
          rates,
        };
        score += (totals.get(src) ?? 0) > 0 ? acc.demand / totals.get(src)! : 0;
      }
      return { value, bySource, score };
    });
    values.sort((a, b) => b.score - a.score);

    const bySource: DimensionStats["bySource"] = {};
    let score = 0;
    for (const [src, acc] of bySrc) {
      const top = Math.max(0, ...values.map((v) => v.bySource[src]?.demand ?? 0));
      bySource[src] = {
        keywords: acc.keywords,
        demand: acc.demand,
        action: acc.action,
        coverage: pct(acc.demand, totals.get(src) ?? 0),
        topShare: pct(top, acc.demand),
      };
      score += (totals.get(src) ?? 0) > 0 ? acc.demand / totals.get(src)! : 0;
    }
    return { name, values, bySource, score };
  });
  dimensions.sort((a, b) => b.score - a.score);
  return { dimensions, genericShare: generic };
}

// ───────────────────────────── listings ─────────────────────────────

// Name/value spec pairs, e.g. {"name": "Material", "value": "MS"} or IndiaMART's
// {"MASTER_DESC": "Material", "OPTIONS_DESC": "PVC, Steel"}.
const NAME_KEYS =
  /^(name|key|label|attribute|attr|spec|specification|title|isq_?name|question|field|param(eter)?|master_?desc|master_?name|spec_?name|attr_?name)$/i;
const VALUE_KEYS =
  /^(value|val|values|answer|option|options|desc|description|detail|isq_?value|response|options?_?desc|option_?value|spec_?value|attr_?value)$/i;

/** Prefix for keys that came from a name/value spec array (ISQ). */
export const SPEC_PREFIX = "isq.";

/** An array of objects that are whole records (nested listings like "more_prod"), not attributes. */
function isNestedRecordArray(arr: unknown[]) {
  const objs = arr.filter((x) => x && typeof x === "object" && !Array.isArray(x)) as Record<
    string,
    unknown
  >[];
  return objs.length > 0 && objs.every((o) => Object.keys(o).length >= 10);
}

/** Flatten a nested listing record into "path": "value" pairs; name/value spec arrays become real spec keys. */
export function flattenListing(
  obj: unknown,
  prefix = "",
  out: Record<string, string> = {},
): Record<string, string> {
  if (obj === null || obj === undefined) return out;
  if (typeof obj !== "object") {
    if (!isEmpty(obj) && prefix) out[prefix] = String(obj).trim();
    return out;
  }
  if (Array.isArray(obj)) {
    if (obj.every((x) => x === null || typeof x !== "object")) {
      const joined = obj.filter((x) => !isEmpty(x)).join(", ");
      if (joined && prefix) out[prefix] = joined;
      return out;
    }
    // Nested listings (other products of the same seller, etc.) would skew fill rates — skip them.
    if (isNestedRecordArray(obj)) return out;
    for (const item of obj) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const keys = Object.keys(item);
        const nk = keys.find((k) => NAME_KEYS.test(k));
        const vk = keys.find((k) => k !== nk && VALUE_KEYS.test(k));
        const rec = item as Record<string, unknown>;
        if (nk && vk && typeof rec[nk] === "string") {
          const v = rec[vk];
          const val = Array.isArray(v) ? v.join(", ") : v;
          const name = String(rec[nk]).trim();
          if (name && !isEmpty(val)) out[`${SPEC_PREFIX}${name}`] = String(val).trim();
          continue;
        }
      }
      flattenListing(item, prefix, out);
    }
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    flattenListing(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

export interface ListingField {
  key: string;
  sources: string[];
  filled: number;
  fillPct: number;
  distinct: number;
  top: [string, number][];
}

export interface PriceStats {
  n: number;
  /** Priced listings left out because they quote a different unit. */
  otherUnits: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  unit: string | null;
}

export interface ListingProfile {
  count: number;
  fields: ListingField[];
  price: PriceStats | null;
  mapped: boolean;
}

/** Roles a source field can be mapped to; anything else is treated as a spec name. */
export type FieldRole = "@name" | "@price" | "@unit" | "@category" | "@ignore";

const IGNORE_KEY =
  /(^|[._\s])(id|_id|uid|sku|url|link|href|src|image|images|img|photo|thumb|thumbnail|video|html|desc|description|created|updated|timestamp|date|seo|slug|meta|rating|review|contact|mobile|phone|email|gst|address|pincode|lat|lng|long)([._\s]|$)/i;
const PRICE_KEY = /price|mrp|\brate\b|cost/i;
const NAME_KEY = /(^|[._\s])(name|title|product_?name|item_?name|heading)$/i;
const CATEGORY_KEY = /(^|[._\s])(category|mcat|mcat_?name|subcategory|group|cat)$/i;
const UNIT_KEY = /(^|[._\s])(unit|uom|price_?unit|moq_?unit)$/i;
// Whole field name only: "city", "specs.city" — not "glusr_distance_city".
const CITY_KEY = /^(.*\.)?(city|city_?orig|seller_?city|location)$/i;

/** "specs.isq_material_type" → "Material Type"; "isq.Material" → "Material". */
export function canonicalSpecName(key: string): string {
  if (key.startsWith(SPEC_PREFIX)) {
    const name = key.slice(SPEC_PREFIX.length).replace(/\s+/g, " ").trim();
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  const last = key.split(".").pop() ?? key;
  const cleaned = last
    .replace(/^(isq|spec|specs|attr|attribute|prop|property)[_\s-]+/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase()) || key;
}

/**
 * Code-only field roles: ignores ids/URLs/contacts and long free text, detects name/category/price/unit,
 * and gives every other field a canonical spec name (fields with the same name merge).
 */
export function heuristicFieldMap(flat: Record<string, string>[]): Map<string, string> {
  const lengths = new Map<string, { total: number; n: number }>();
  for (const rec of flat)
    for (const [k, v] of Object.entries(rec)) {
      const l = lengths.get(k) ?? { total: 0, n: 0 };
      l.total += v.length;
      l.n++;
      lengths.set(k, l);
    }
  // When most listings carry a structured spec list (ISQ), those ARE the specs: every other raw
  // field (ids, flags, ranks, seller metadata…) is noise, except the seller's city.
  const withSpecs = flat.filter((r) =>
    Object.keys(r).some((k) => k.startsWith(SPEC_PREFIX)),
  ).length;
  const specMode = withSpecs >= Math.max(1, flat.length * 0.3);

  // Case/spacing variants of one spec name ("Surface treatment" / "Surface Treatment") merge in code.
  const display = new Map<string, string>();
  const unify = (name: string) => {
    const k = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!display.has(k)) display.set(k, name);
    return display.get(k)!;
  };

  const map = new Map<string, string>();
  for (const [key, l] of lengths) {
    const avgLen = l.total / Math.max(l.n, 1);
    let role: string;
    if (key.startsWith(SPEC_PREFIX)) role = canonicalSpecName(key);
    else if (CITY_KEY.test(key)) role = "Seller City";
    else if (IGNORE_KEY.test(key)) role = "@ignore";
    else if (NAME_KEY.test(key)) role = "@name";
    else if (CATEGORY_KEY.test(key)) role = "@category";
    else if (UNIT_KEY.test(key)) role = "@unit";
    else if (PRICE_KEY.test(key)) role = "@price";
    else if (specMode || key === "_group") role = "@ignore";
    else if (avgLen > 80)
      role = "@ignore"; // free text, not an attribute
    else role = canonicalSpecName(key);
    map.set(key, role.startsWith("@") ? role : unify(role));
  }
  return map;
}

function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo));
}

/** Per-field fill rates and common values. With a mapping, source keys are merged onto canonical specs. */
export function profileListings(
  flat: Record<string, string>[],
  mapping?: Map<string, string>,
): ListingProfile {
  const count = flat.length;
  const map = mapping ?? heuristicFieldMap(flat);
  const roleOf = (key: string): string => map.get(key) ?? "@ignore";

  const fields = new Map<
    string,
    { sources: Set<string>; filledRows: number; values: Map<string, { label: string; n: number }> }
  >();
  // Price and unit per listing: quartiles are only meaningful within one unit (piece vs sq ft).
  const priced: { price: number; unit: string | null }[] = [];

  for (const rec of flat) {
    const seen = new Set<string>();
    let price: number | null = null;
    let unit: string | null = null;
    for (const [key, raw] of Object.entries(rec)) {
      const role = roleOf(key);
      if (role === "@ignore" || role === "@name" || role === "@category") continue;
      if (role === "@price") {
        if (price === null) {
          const m = raw.replace(/,/g, "").match(/\d+(\.\d+)?/);
          if (m) price = Number(m[0]);
          const u = raw.split("/")[1]?.trim().toLowerCase();
          if (u && !unit) unit = u;
        }
        continue;
      }
      if (role === "@unit") {
        const u = raw.trim().toLowerCase();
        if (u) unit = u;
        continue;
      }
      let f = fields.get(role);
      if (!f) {
        f = { sources: new Set(), filledRows: 0, values: new Map() };
        fields.set(role, f);
      }
      f.sources.add(key);
      if (seen.has(role)) continue; // first mapped source wins for this listing
      seen.add(role);
      f.filledRows++;
      // ISQ values are multi-select ("PVC, Stainless Steel"): count each option on its own.
      const parts = key.startsWith(SPEC_PREFIX) ? raw.split(",") : [raw];
      for (const part of parts) {
        const label = part.trim().slice(0, 80);
        if (!label) continue;
        const norm = label.toLowerCase().replace(/\s+/g, " ");
        const v = f.values.get(norm);
        if (v) v.n++;
        else f.values.set(norm, { label, n: 1 });
      }
    }
    if (price !== null && price > 0) priced.push({ price, unit });
  }

  const out: ListingField[] = [...fields.entries()]
    .map(([key, f]) => ({
      key,
      sources: [...f.sources],
      filled: f.filledRows,
      fillPct: pct(f.filledRows, count),
      distinct: f.values.size,
      top: [...f.values.values()]
        .sort((a, b) => b.n - a.n)
        .slice(0, 8)
        .map((v) => [v.label, v.n] as [string, number]),
    }))
    .sort((a, b) => b.filled - a.filled)
    .slice(0, 60);

  const unitCounts = new Map<string, number>();
  for (const p of priced) if (p.unit) unitCounts.set(p.unit, (unitCounts.get(p.unit) ?? 0) + 1);
  const topUnit = [...unitCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const prices = priced
    .filter((p) => !topUnit || p.unit === topUnit || p.unit === null)
    .map((p) => p.price)
    .sort((a, b) => a - b);
  const price: PriceStats | null =
    prices.length >= 3
      ? {
          n: prices.length,
          otherUnits: priced.length - prices.length,
          min: prices[0]!,
          p25: quantile(prices, 0.25),
          median: quantile(prices, 0.5),
          p75: quantile(prices, 0.75),
          max: prices[prices.length - 1]!,
          unit: topUnit,
        }
      : null;

  return { count, fields: out, price, mapped: Boolean(mapping) };
}

/**
 * Canonical spec names (after the code-only mapping) with fill rate, source fields and sample values —
 * all the field-mapping model call needs to merge synonyms. Ignored/name/price fields are not sent.
 */
export function specSummary(
  flat: Record<string, string>[],
  map: Map<string, string>,
  maxSpecs = 60,
  minFillPct = 2,
) {
  const stats = new Map<string, { rows: number; samples: string[]; sources: Set<string> }>();
  for (const rec of flat) {
    const seen = new Set<string>();
    for (const [k, v] of Object.entries(rec)) {
      const role = map.get(k) ?? "@ignore";
      if (role.startsWith("@")) continue;
      let s = stats.get(role);
      if (!s) {
        s = { rows: 0, samples: [], sources: new Set() };
        stats.set(role, s);
      }
      s.sources.add(k);
      if (!seen.has(role)) {
        seen.add(role);
        s.rows++;
      }
      const short = v.slice(0, 30);
      if (s.samples.length < 3 && !s.samples.includes(short)) s.samples.push(short);
    }
  }
  return (
    [...stats.entries()]
      .sort((a, b) => b[1].rows - a[1].rows)
      // The long tail of one-off spec names isn't worth merging (and costs tokens).
      .filter(([, s]) => pct(s.rows, flat.length) >= minFillPct)
      .slice(0, maxSpecs)
      .map(([spec, s]) => ({
        spec,
        fillPct: pct(s.rows, flat.length),
        samples: s.samples,
        sources: [...s.sources],
      }))
  );
}

// ───────────────────────────── category dimensions ─────────────────────────────

export interface DimensionCandidates {
  /** Spec names from the category manager's ranking, in ranked order. */
  ranking: string[];
  /** Listing spec names with their most common values, by fill rate. */
  listing: { name: string; fillPct: number; values: string[] }[];
}

/** "Green (top): 1-Size, 2-Material" → ["Size", "Material"]. */
export function parseRankingNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const body = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line;
    for (const raw of body.split(/[,;|]/)) {
      const name = raw
        .replace(/^\s*[-•*]?\s*\d+\s*[-.)]\s*/, "")
        .replace(/\(.*?\)/g, "")
        .trim();
      if (name.length >= 2 && name.length <= 40 && /[a-z]/i.test(name) && !names.includes(name))
        names.push(name);
    }
  }
  return names.slice(0, 30);
}

/**
 * The category's own filter dimensions — used instead of a fixed list when labelling keyword terms,
 * so keyword demand lands on the same names as the ranking and the listing specs.
 */
export function dimensionCandidates(
  specsRanking: string,
  listing: ListingProfile | null,
): DimensionCandidates {
  return {
    ranking: parseRankingNames(specsRanking),
    listing: (listing?.fields ?? [])
      .filter((f) => f.fillPct >= 3)
      .slice(0, 25)
      .map((f) => ({ name: f.key, fillPct: f.fillPct, values: f.top.slice(0, 5).map(([v]) => v) })),
  };
}

/** Point code-labelled sizes/places at the category's own dimension names when it has them. */
export function alignAutoLabels(labels: TermLabel[], c: DimensionCandidates): TermLabel[] {
  const names = [...c.listing.map((l) => l.name), ...c.ranking];
  const sizeName = names.find((n) => /\b(size|dimension)/i.test(n));
  const placeName = names.find((n) => /\b(city|location)\b/i.test(n));
  return labels.map((l) =>
    l.dimension === "Size / Capacity" && sizeName
      ? { ...l, dimension: sizeName }
      : l.dimension === "Location" && placeName
        ? { ...l, dimension: placeName }
        : l,
  );
}
