import {
  flattenListing,
  heuristicFieldMap,
  normalizeQuery,
  SOURCE_LABEL,
  type KeywordSource,
  type KeywordTable,
  type Row,
} from "./data";
import type { PipelineInputs } from "./filter-gen";

/*
 * Several MCATs in one run. The product file holds one group per MCAT (JSON `{"mcat-a": [...], ...}`
 * or an `mcat` column); each MCAT then gets its own pipeline run. What is cut per MCAT and what is not:
 *   - listings          the MCAT's own listings (fill rates, values and price come from these)
 *   - context / ranking the MCAT's section when the document marks sections by MCAT name, else shared
 *   - SERP + internal keywords   the files are COMMON to all MCATs, but each MCAT works only on the
 *                       keywords that are about it (selectMcatKeywords), picked in code before any
 *                       model call: its name, its PMCAT, or words distinctive to its own listings
 */

export interface McatScope {
  name: string;
  /** The MCAT's id from the product file (`input_mcat.id`), when it has one. */
  id?: string;
  /** The MCAT's primary PMCAT (the parent product category), when the product file names it. */
  pmcat?: { id?: string; name: string };
  /** The subcategory the MCATs belong to, when the product file names it (`subcat_id`, `subcat_name`). */
  subcat?: { id?: string; name?: string };
  /** The other MCATs of the same subcategory; each is designed in its own run. */
  siblings: string[];
  listings: number;
  /** Plain-words notes on how this MCAT's inputs were cut from the subcategory's files. */
  notes: string[];
  /**
   * Words found in this MCAT's listing specs and in no other MCAT's (stemmed): a keyword containing one
   * is about this MCAT even when it doesn't say the MCAT's name ("lph" for a dairy plant).
   */
  vocab?: string[];
  /** Scores keywords against every MCAT of the run at once (see buildMatchers); set by splitByMcat. */
  matcher?: McatMatcher;
  /** Set by prepare(): which of each common keyword file's keywords were picked for this MCAT. */
  keywordSelection?: KeywordSelection[];
}

export interface KeywordSelection {
  source: KeywordSource;
  /** Keywords about this MCAT, and all keywords in the file. */
  selected: number;
  total: number;
  /** Share (%) of the file's demand those keywords hold. */
  demandPct: number;
  /** False when too few keywords were about this MCAT: the file is then left out for it. */
  used: boolean;
}

export interface McatSlice {
  name: string;
  inputs: PipelineInputs;
}

const MCAT_COLUMN = /^(mcat|mcat[ _.-]?name)$/i;
/** Fewer listings than this and the fill rates are rough. */
const FEW_LISTINGS = 20;

// ───────────────────────────── names ─────────────────────────────

const STOP = new Set(["and", "or", "of", "the", "for", "in", "with"]);

function stem(t: string) {
  if (t.length <= 3) return t;
  if (t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(t)) return t;
  if (/(x|ch|sh|s)es$/.test(t)) return t.slice(0, -2);
  return t.endsWith("s") ? t.slice(0, -1) : t;
}

/** The words of an MCAT name, lower-case and singular: "Portable Cabins" → ["portable", "cabin"]. */
export function nameTokens(name: string): string[] {
  return normalizeQuery(name.replace(/[-_&/]+/g, " "))
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/** "portable-cabins" → "Portable Cabins"; names that already read well are left alone. */
export function mcatNameOf(raw: string): string {
  const t = raw.trim();
  return /^[a-z0-9]+([-_][a-z0-9]+)+$/.test(t)
    ? t.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : t;
}

// ───────────────────────────── listings ─────────────────────────────

const MCAT_ID_COLUMN = /^mcat[ _.-]?id$/i;

/** Where the MCAT is in a listing row: the JSON group tag, or an `mcat` column. */
function mcatKeyOf(rows: Row[]): string | null {
  if (rows.some((r) => typeof r["_group"] === "string")) return "_group";
  const keys = new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)));
  return [...keys].find((k) => MCAT_COLUMN.test(k)) ?? null;
}

// ───────────────────────────── context / ranking sections ─────────────────────────────

/**
 * Splits a document into a shared part and one section per MCAT. A section starts at a line that is
 * just the MCAT's name ("## Portable Cabins", "MCAT: Portable Cabins", "Portable Cabins:") and runs
 * to the next such line. Text above the first one is shared by every MCAT. Returns null when the
 * document has no such lines (everything is then shared).
 *
 * A Spec Audit loaded from the MCAT API ("# Name — Seller & Buyer Spec Audit", then "**Mcat Id:** 123")
 * also starts a section: its MCAT is found by that id first (`ids`: MCAT name → id), then by the name in
 * its heading. An audit of an MCAT that isn't in this run is left out of every MCAT's text.
 */
export function splitDoc(
  text: string,
  names: string[],
  ids: Map<string, string> = new Map(),
): { shared: string; sections: Map<string, string> } | null {
  if (!text.trim()) return null;
  const keyOf = (s: string) => nameTokens(s).join(" ");
  const byKey = new Map(names.map((n) => [keyOf(n), n]));
  byKey.delete("");
  const byId = new Map([...ids].filter(([, id]) => id).map(([n, id]) => [id, n]));
  const shared: string[] = [];
  const sections = new Map<string, string[]>();
  let current: string[] = shared;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const audit = line.match(/^#\s+(.*?)\s*(?:[—–-]+\s*)?Seller\s*&\s*Buyer Spec Audit/i);
    if (audit) {
      const idLine = lines.slice(i + 1, i + 8).join("\n");
      const id = idLine.match(/\*\*\s*Mcat[ _]?Id\s*:?\s*\*\*:?\s*(\d+)/i)?.[1];
      const owner = (id ? byId.get(id) : undefined) ?? byKey.get(keyOf(audit[1] ?? ""));
      if (owner) {
        current = sections.get(owner) ?? [];
        sections.set(owner, current);
      } else current = []; // an audit of another MCAT: kept out of every section
      current.push(line);
      continue;
    }
    const cleaned = line
      .trim()
      .replace(/^[#>*\-\s]+/, "")
      .replace(/^(mcat|category|product|subcategory)\s*[:–-]\s*/i, "")
      .replace(/[\s:*\-–]+$/, "");
    const name = line.length <= 90 && cleaned ? byKey.get(keyOf(cleaned)) : undefined;
    if (name) {
      current = sections.get(name) ?? [];
      sections.set(name, current);
      continue;
    }
    current.push(line);
  }
  if (!sections.size) return null;
  const join = (l: string[]) => l.join("\n").trim();
  return {
    shared: join(shared),
    sections: new Map([...sections].map(([n, l]) => [n, join(l)])),
  };
}

const docFor = (split: ReturnType<typeof splitDoc>, whole: string, name: string) =>
  split ? [split.shared, split.sections.get(name) ?? ""].filter(Boolean).join("\n\n") : whole;

// ───────────────────────────── the split ─────────────────────────────

/**
 * One slice per MCAT when the product file holds two or more; [] when it doesn't (or splitting is
 * switched off), meaning the run is a plain single-category run. Slices are ordered by listing count.
 */
export function splitByMcat(inputs: PipelineInputs): McatSlice[] {
  // The page, the preview and Generate ask with the same inputs one after another; the split is not cheap.
  if (lastSplit && sameInputs(lastSplit.inputs, inputs)) return lastSplit.slices;
  const slices = splitUncached(inputs);
  lastSplit = { inputs, slices };
  return slices;
}

let lastSplit: { inputs: PipelineInputs; slices: McatSlice[] } | null = null;

function sameInputs(a: PipelineInputs, b: PipelineInputs): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof PipelineInputs>;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function splitUncached(inputs: PipelineInputs): McatSlice[] {
  if (inputs.separateMcats === false) return [];
  const key = mcatKeyOf(inputs.listingRows);
  if (!key) return [];
  // The id column, when there is one: two MCATs with the same name but different ids stay apart.
  const idKey =
    key === "_group"
      ? "_mcat_id"
      : [...new Set(inputs.listingRows.slice(0, 50).flatMap((r) => Object.keys(r)))].find((k) =>
          MCAT_ID_COLUMN.test(k),
        );
  const groups = new Map<string, { name: string; rows: Row[] }>();
  let untagged = 0;
  for (const r of inputs.listingRows) {
    const raw = String(r[key] ?? "").trim();
    if (!raw) {
      untagged++;
      continue;
    }
    const id = idKey ? String(r[idKey] ?? "").trim() : "";
    const groupKey = id || mcatNameOf(raw).toLowerCase();
    const group = groups.get(groupKey);
    if (group) group.rows.push(r);
    else groups.set(groupKey, { name: mcatNameOf(raw), rows: [r] });
  }
  if (groups.size < 2) return [];

  const ordered = [...groups.values()]
    .sort((a, b) => b.rows.length - a.rows.length)
    .map(({ name, rows }) => [name, rows] as const);
  const names = ordered.map(([n]) => n);
  const vocabs = distinctiveVocab(ordered.map(([, rows]) => rows));
  const matchers = buildMatchers(
    ordered.map(([name, rows], i) => ({
      name,
      pmcat: String(rows[0]?.["_pmcat"] ?? "").trim(),
      vocab: vocabs[i] ?? [],
    })),
  );
  const ids = new Map(
    ordered.map(([name, rows]) => [name, idKey ? String(rows[0]?.[idKey] ?? "").trim() : ""]),
  );
  const context = splitDoc(inputs.context, names, ids);
  const ranking = splitDoc(inputs.specs, names, ids);

  return ordered.map(([name, rows], index) => {
    const notes: string[] = [];
    if (rows.length < FEW_LISTINGS)
      notes.push(
        `Listings: only ${rows.length} listing${rows.length === 1 ? "" : "s"} for this MCAT, so its fill rates and common values are rough.`,
      );
    if (untagged)
      notes.push(`${untagged} listing(s) in the file had no MCAT and were left out of every MCAT.`);
    if (context && !context.sections.has(name))
      notes.push(
        "Context: the context document has no section for this MCAT; only its shared part was used.",
      );
    if (ranking && !ranking.sections.has(name))
      notes.push(
        "Ranking: the ranking has no section for this MCAT; only its shared part was used.",
      );
    const first = rows[0]!;
    const id = idKey ? String(first[idKey] ?? "").trim() : "";
    const pmcatName = String(first["_pmcat"] ?? "").trim();
    const pmcatId = String(first["_pmcat_id"] ?? "").trim();
    const subcatId = String(first["_subcat_id"] ?? "").trim();
    const subcatName = String(first["_subcat"] ?? "").trim();
    return {
      name,
      inputs: {
        ...inputs,
        listingRows: rows,
        context: docFor(context, inputs.context, name),
        specs: docFor(ranking, inputs.specs, name),
        mcat: {
          name,
          ...(id ? { id } : {}),
          ...(pmcatName ? { pmcat: { ...(pmcatId ? { id: pmcatId } : {}), name: pmcatName } } : {}),
          ...(subcatId || subcatName
            ? {
                subcat: {
                  ...(subcatId ? { id: subcatId } : {}),
                  ...(subcatName ? { name: subcatName } : {}),
                },
              }
            : {}),
          siblings: names.filter((n) => n !== name),
          listings: rows.length,
          vocab: vocabs[index] ?? [],
          matcher: matchers[index]!,
          notes,
        },
      },
    };
  });
}

// ───────────────────────────── which MCAT a run is about ─────────────────────────────

export interface McatIdentity {
  id?: string;
  name?: string;
  pmcat?: { id?: string; name: string };
  subcat?: { id?: string; name?: string };
}

/** A cell as an MCAT id and name: plain text, or a product's own `mcat` field (`[{id, name}]`). */
function idNameOf(v: unknown): { id: string; name: string } {
  const o = Array.isArray(v) ? v[0] : v;
  if (o && typeof o === "object") {
    const rec = o as Record<string, unknown>;
    return {
      id: rec["id"] == null ? "" : String(rec["id"]).trim(),
      name: rec["name"] == null ? "" : String(rec["name"]).trim(),
    };
  }
  return { id: "", name: v == null ? "" : String(v).trim() };
}

/**
 * The one MCAT a run is about: from the product file's own tags (an MCAT wrapper, an `mcat` / `mcat_id`
 * column, a product's `mcat` field) when every listing names the same one, else from a Seller & Buyer Spec
 * Audit in the context ("# Name — Seller & Buyer Spec Audit", then "**Mcat Id:** 123"). `name` narrows a
 * file of several MCATs to that one's listings and audit. null when the inputs don't say, or name several.
 */
export function mcatIdentity(rows: Row[], context: string, name?: string): McatIdentity | null {
  const keyOf = (s: string) => nameTokens(s).join(" ");
  const key = mcatKeyOf(rows);
  const idKey =
    key === "_group"
      ? "_mcat_id"
      : [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))].find((k) =>
          MCAT_ID_COLUMN.test(k),
        );
  const cells = key
    ? rows
        .map((r) => {
          const own = idNameOf(r[key]);
          return {
            r,
            id: (idKey ? String(r[idKey] ?? "").trim() : "") || own.id,
            name: mcatNameOf(own.name),
          };
        })
        .filter((c) => c.id || c.name)
        .filter((c) => !name || keyOf(c.name) === keyOf(name))
    : [];
  const ids = new Set(cells.map((c) => c.id).filter(Boolean));
  const names = new Set(cells.map((c) => keyOf(c.name)).filter(Boolean));
  if (cells.length && ids.size <= 1 && names.size <= 1) {
    const first = cells[0]!;
    const text = (k: string) => String(first.r[k] ?? "").trim();
    const out: McatIdentity = {};
    const id = [...ids][0] ?? "";
    const own = cells.find((c) => c.name)?.name ?? "";
    if (id) out.id = id;
    if (own) out.name = own;
    if (text("_pmcat"))
      out.pmcat = { ...(text("_pmcat_id") ? { id: text("_pmcat_id") } : {}), name: text("_pmcat") };
    if (text("_subcat_id") || text("_subcat"))
      out.subcat = {
        ...(text("_subcat_id") ? { id: text("_subcat_id") } : {}),
        ...(text("_subcat") ? { name: text("_subcat") } : {}),
      };
    if (out.id || out.name) return out;
  }

  // No listing says: a spec audit in the context names its MCAT and id.
  const audits: { id: string; name: string }[] = [];
  const lines = context.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]!.match(/^#\s+(.*?)\s*(?:[—–-]+\s*)?Seller\s*&\s*Buyer Spec Audit/i);
    if (!head) continue;
    const id =
      lines
        .slice(i + 1, i + 8)
        .join("\n")
        .match(/\*{0,2}\s*Mcat[ _]?Id\s*:?\s*\*{0,2}:?\s*(\d+)/i)?.[1] ?? "";
    audits.push({ id, name: (head[1] ?? "").trim() });
  }
  const mine = name ? audits.filter((a) => keyOf(a.name) === keyOf(name)) : audits;
  const auditIds = new Set(mine.map((a) => a.id).filter(Boolean));
  if (mine.length && auditIds.size <= 1) {
    const a = mine.find((x) => x.id) ?? mine[0]!;
    const out: McatIdentity = {};
    if (a.id) out.id = a.id;
    if (a.name) out.name = a.name;
    if (out.id || out.name) return out;
  }
  return null;
}

/** Writes the MCAT's id, name, PMCAT and subcategory onto a result, keeping what the result already says. */
export function withMcatIdentity<
  R extends {
    mcat_id?: string;
    mcat_name?: string;
    pmcat?: { id?: string; name: string };
    subcat_id?: string;
    subcat_name?: string;
  },
>(result: R, who: McatIdentity | null): R {
  if (!who) return result;
  const out = { ...result };
  if (!out.mcat_id && who.id) out.mcat_id = who.id;
  if (!out.mcat_name && who.name) out.mcat_name = who.name;
  if (!out.pmcat && who.pmcat) out.pmcat = who.pmcat;
  if (!out.subcat_id && who.subcat?.id) out.subcat_id = who.subcat.id;
  if (!out.subcat_name && who.subcat?.name) out.subcat_name = who.subcat.name;
  return out;
}

// ───────────────────────────── keywords for one MCAT ─────────────────────────────

/** A listing word must be filled on at least this share of the MCAT's listings to count as its vocabulary. */
const VOCAB_MIN_SHARE = 0.05;
const VOCAB_MAX = 150;
/** Fewer keywords than this about an MCAT and its keyword file is left out for it (too thin to total). */
export const MIN_MCAT_KEYWORDS = 10;

/** What a word is worth to the MCAT that owns it: its own name most, then its PMCAT's, then its listings'. */
const W_NAME = 3;
const W_PMCAT = 2;
const W_VOCAB = 1;
/**
 * A keyword's coverage of an MCAT is the share of the MCAT's identity (its name words, each worth its
 * weight split between the MCATs that share it; its PMCAT's words add to what the keyword holds) that it holds: "bakery oven" holds all of Bakery
 * Oven and a sliver of Combi Oven; "oven" alone holds a fifth of Bakery Oven. A keyword is an MCAT's when it
 * covers at least MIN_COVER of it and at least COMPETE × the best coverage any MCAT gets from it.
 */
const MIN_COVER = 0.5;
const COMPETE = 0.75;
/** A word in more than about this share of the file's keywords ("machine" in a machinery file) says nothing, and is ignored. */
const MIN_RARITY = 0.15;
/** A listing-only word the keywords have confirmed adds this much coverage (a half: enough to qualify, not to win alone). */
const VOCAB_COVER = 0.5;
/**
 * A word that only the MCAT's listings use (not its name or PMCAT) counts for it only if the keywords holding
 * it that are already assigned by name go mostly to that MCAT (at least this share, from at least
 * VOCAB_MIN_HITS of them): "genset" does, "sale" and "small" are spread over every MCAT. A word with no
 * assigned keyword to judge by does not count: nothing confirms it.
 */
const VOCAB_MIN_SHARE_OF_HITS = 0.6;
const VOCAB_MIN_HITS = 2;
/** Pieces of a run-together word ("bulkmilkcooler") are at least this long; only words up to MAX_JOINED are tried. */
const MIN_PART = 3;
const MAX_JOINED = 40;

/** The words of a text, stemmed. A number with a unit ("500lph") gives the unit ("lph"); bare numbers give nothing. */
function wordsOf(text: string): string[] {
  const out: string[] = [];
  for (const w of normalizeQuery(text).split(" ")) {
    if (!w) continue;
    const unit = /^[0-9.x]+([a-z]{3,})$/.exec(w);
    if (unit) out.push(stem(unit[1]!));
    else if (!/^[0-9]/.test(w)) out.push(stem(w));
  }
  return out;
}

/**
 * For each MCAT, the words its listings use that no other MCAT's listings use (stemmed, 3+ letters, on
 * at least 5% of its listings): "lph" and "pasteurizer" belong to a dairy plant, "stainless" to everyone.
 */
function distinctiveVocab(groups: Row[][]): string[][] {
  const perMcat = groups.map((rows) => {
    const sample = rows.slice(0, 500).map((r) => flattenListing(r));
    const map = heuristicFieldMap(sample);
    const counts = new Map<string, number>();
    for (const rec of sample) {
      const seen = new Set<string>();
      for (const [key, value] of Object.entries(rec)) {
        if ((map.get(key) ?? "@ignore").startsWith("@")) continue; // ids, names, price: not spec words
        for (const t of wordsOf(value)) if (t.length >= 3 && !STOP.has(t)) seen.add(t);
      }
      for (const t of seen) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const floor = Math.max(2, Math.ceil(sample.length * VOCAB_MIN_SHARE));
    return new Map([...counts].filter(([, n]) => n >= floor));
  });
  return perMcat.map((mine, i) =>
    [...mine]
      .filter(([t]) => perMcat.every((other, j) => j === i || !other.has(t)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, VOCAB_MAX)
      .map(([t]) => t),
  );
}

/** Scores a keyword against every MCAT of the run at once; `index` is this MCAT's place in the answer. */
export interface McatMatcher {
  index: number;
  /** Every word some MCAT owns (its name, PMCAT or listing words). */
  owned: string[];
  /** The words of a keyword (stemmed; run-together words cut into the index's words). */
  words: (tokens: string[]) => Set<string>;
  /** The MCATs a word belongs to by its listings only (not by name or PMCAT). */
  vocabOwners: Map<string, number[]>;
  /**
   * How well a keyword's words fit each MCAT. `rarity` scales a word down the more keywords hold it;
   * `vocabOk` says whether a listing-only word counts for an MCAT (default: yes).
   */
  score: (
    have: Set<string>,
    rarity?: (word: string) => number,
    vocabOk?: (word: string, mcat: number) => boolean,
  ) => number[];
}

/**
 * One shared word index for all MCATs of a run: word → the MCATs that own it and what it is worth to each.
 * A keyword is broken into words (a run-together word like "bulkmilkcooler" is cut into the index's words
 * by a memoised word-break DP), each word is looked up, and the weights are added per MCAT. A word several
 * MCATs share has its weight split between them, so it can't decide on its own which MCAT a keyword is for.
 */
function buildMatchers(mcats: { name: string; pmcat: string; vocab: string[] }[]): McatMatcher[] {
  const owners = new Map<string, Map<number, number>>();
  const give = (word: string, mcat: number, w: number) => {
    let byMcat = owners.get(word);
    if (!byMcat) owners.set(word, (byMcat = new Map()));
    byMcat.set(mcat, Math.max(byMcat.get(mcat) ?? 0, w));
  };
  mcats.forEach((m, i) => {
    for (const t of nameTokens(m.name)) give(t, i, W_NAME);
    if (m.pmcat) for (const t of nameTokens(m.pmcat)) give(t, i, W_PMCAT);
    for (const t of m.vocab) give(t, i, W_VOCAB);
  });
  // word -> [MCAT, weight shared out between the MCATs that own the word, what the word is to that MCAT (W_NAME / W_PMCAT / W_VOCAB)]
  const weight = new Map<string, [number, number, number][]>();
  for (const [word, byMcat] of owners)
    weight.set(
      word,
      [...byMcat].map(([i, w]) => [i, w / byMcat.size, w] as [number, number, number]),
    );
  const longest = Math.max(0, ...[...weight.keys()].map((w) => w.length));
  const known = (w: string) => weight.has(w);

  const segments = new Map<string, string[]>();
  /** Fewest-pieces cut of `raw` into index words, [] when there is none (or it is a single word). */
  const segment = (raw: string): string[] => {
    const hit = segments.get(raw);
    if (hit) return hit;
    const n = raw.length;
    const pieces = new Array<number>(n + 1).fill(Infinity);
    const from = new Array<number>(n + 1).fill(-1);
    pieces[0] = 0;
    for (let end = MIN_PART; end <= n; end++) {
      for (let start = Math.max(0, end - longest - 2); start <= end - MIN_PART; start++) {
        if (pieces[start] === Infinity) continue;
        const piece = raw.slice(start, end);
        if ((known(piece) || known(stem(piece))) && pieces[start]! + 1 < pieces[end]!) {
          pieces[end] = pieces[start]! + 1;
          from[end] = start;
        }
      }
    }
    const out: string[] = [];
    if (pieces[n]! >= 2 && pieces[n] !== Infinity)
      for (let end = n; end > 0; end = from[end]!) out.unshift(stem(raw.slice(from[end]!, end)));
    segments.set(raw, out);
    return out;
  };

  const words = new Map<string, string[]>();
  const wordsCached = (t: string) => {
    let w = words.get(t);
    if (!w) words.set(t, (w = wordsOf(t)));
    return w;
  };

  const wordsOfKeyword = (tokens: string[]) => {
    const have = new Set<string>();
    for (const t of tokens)
      for (const w of wordsCached(t)) {
        have.add(w);
        if (!known(w) && w.length >= 6 && w.length <= MAX_JOINED && !/[0-9]/.test(w))
          for (const part of segment(w)) have.add(part);
      }
    return have;
  };
  // What an MCAT's whole identity is worth: its own name words. Its PMCAT's words only add to what a
  // keyword holds (a keyword needn't say the PMCAT to be about the MCAT), and its listing words are judged
  // by the keywords (see analyse()).
  const identity = new Array<number>(mcats.length).fill(0);
  for (const entries of weight.values())
    for (const [i, x, base] of entries) if (base >= W_NAME) identity[i]! += x;
  const score = (
    have: Set<string>,
    rarity: (word: string) => number = () => 1,
    vocabOk: (word: string, mcat: number) => boolean = () => true,
  ) => {
    const held = new Array<number>(mcats.length).fill(0);
    const confirmed = new Array<boolean>(mcats.length).fill(false);
    for (const w of have) {
      if (rarity(w) < MIN_RARITY) continue;
      for (const [i, x, base] of weight.get(w) ?? []) {
        if (base > W_VOCAB) held[i]! += x;
        else if (vocabOk(w, i)) confirmed[i] = true;
      }
    }
    return held.map((h, i) =>
      Math.min(1, (identity[i]! > 0 ? h / identity[i]! : 0) + (confirmed[i] ? VOCAB_COVER : 0)),
    );
  };
  const vocabOwners = new Map<string, number[]>();
  for (const [word, entries] of weight) {
    const mine = entries.filter(([, , base]) => base <= W_VOCAB).map(([i]) => i);
    if (mine.length) vocabOwners.set(word, mine);
  }
  const owned = [...weight.keys()];
  return mcats.map((_, index) => ({ index, owned, vocabOwners, words: wordsOfKeyword, score }));
}

// ───────────────────── word clusters: spelling and derivation variants of an MCAT's words ─────────────────────

/** Words that share their first letters this many are candidates for the same family ("machine"/"machinery"). */
const PREFIX_KEY = 5;

/** Edit distance at most 1: one letter changed, added or dropped. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const d = a.length - b.length;
  if (d > 1 || d < -1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (d === 0) return a.slice(i + 1) === b.slice(i + 1);
  return d === 1 ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** The same word in another form: one typo apart ("pasteuriser"/"pasteurizer"), or a long shared start ("machine"/"machinery"). */
function sameFamily(a: string, b: string): boolean {
  const shorter = Math.min(a.length, b.length);
  if (shorter >= 5 && withinOneEdit(a, b)) return true;
  if (shorter < 6) return false;
  let p = 0;
  while (p < shorter && a[p] === b[p]) p++;
  return p >= Math.max(PREFIX_KEY, Math.ceil(shorter * 0.6));
}

/**
 * Clusters the keyword file's words around the MCATs' words. Words go into buckets (the SymSpell idea: the
 * word itself, each one-letter deletion, and its first 5 letters), so only words that share a bucket are
 * compared. A word that is a variant of an MCAT word joins that word's cluster and counts as the MCAT word:
 * "pasteuriser", "pasteurization" and "pasteurizer" are one family. Clusters form only around MCAT words,
 * so similar-looking words can't chain into each other.
 */
function variantMap(vocab: Iterable<string>, owned: string[]): Map<string, string[]> {
  const bucket = new Map<string, string[]>();
  const put = (key: string, w: string) => {
    const list = bucket.get(key);
    if (list) list.push(w);
    else bucket.set(key, [w]);
  };
  for (const w of vocab) {
    if (w.length < 5) continue;
    put(w, w);
    for (let i = 0; i < w.length; i++) put(w.slice(0, i) + w.slice(i + 1), w);
    if (w.length >= 6) put("^" + w.slice(0, PREFIX_KEY), w);
  }
  const variants = new Map<string, string[]>();
  for (const o of owned) {
    if (o.length < 5) continue;
    const keys = [o];
    for (let i = 0; i < o.length; i++) keys.push(o.slice(0, i) + o.slice(i + 1));
    if (o.length >= 6) keys.push("^" + o.slice(0, PREFIX_KEY));
    const seen = new Set<string>();
    for (const key of keys)
      for (const v of bucket.get(key) ?? []) {
        if (v === o || seen.has(v)) continue;
        seen.add(v);
        if (!sameFamily(o, v)) continue;
        const list = variants.get(v);
        if (list) list.push(o);
        else variants.set(v, [o]);
      }
  }
  return variants;
}

interface TableAnalysis {
  /** Each keyword's words, with the MCAT words its spelling variants stand for added. */
  sets: Set<string>[];
  /** 1 = a word in one keyword, ~0.1 = a word in nearly all: "price" or "automatic" says little. */
  rarity: (word: string) => number;
  /** Whether a listing-only word counts for an MCAT: the keywords it appears in must mostly belong to that MCAT. */
  vocabOk: (word: string, mcat: number) => boolean;
}

// One analysis per keyword table and word index, shared by every MCAT of the run (the table is the same).
const analyses = new WeakMap<KeywordTable, WeakMap<McatMatcher["words"], TableAnalysis>>();

function analyse(t: KeywordTable, matcher: McatMatcher): TableAnalysis {
  let byIndex = analyses.get(t);
  if (!byIndex) analyses.set(t, (byIndex = new WeakMap()));
  const hit = byIndex.get(matcher.words);
  if (hit) return hit;
  const base = t.rows.map((r) => matcher.words(r.tokens));
  const vocab = new Set<string>();
  for (const set of base) for (const w of set) vocab.add(w);
  const variants = variantMap(vocab, matcher.owned);
  const sets = base.map((set) => {
    const out = new Set(set);
    for (const w of set) for (const owned of variants.get(w) ?? []) out.add(owned);
    return out;
  });
  const df = new Map<string, number>();
  for (const set of sets) for (const w of set) df.set(w, (df.get(w) ?? 0) + 1);
  const n = Math.max(t.rows.length, 2);
  const rarity = (w: string) => Math.max(0.1, Math.log(n / (df.get(w) ?? 1)) / Math.log(n));
  // Pass 1: each keyword's MCAT by name / PMCAT words alone. Pass 2: for each listing-only word, where do
  // the keywords that hold it (and were assigned in pass 1) go? Concentrated on one MCAT = a real word of it.
  const byName = sets.map((set) => {
    const sc = matcher.score(set, rarity, () => false);
    const best = Math.max(...sc);
    return best >= MIN_COVER ? sc.indexOf(best) : -1;
  });
  const tally = new Map<string, Map<number, number>>();
  sets.forEach((set, i) => {
    const mcat = byName[i]!;
    if (mcat < 0) return;
    for (const w of set) {
      if (!matcher.vocabOwners.has(w)) continue;
      let per = tally.get(w);
      if (!per) tally.set(w, (per = new Map()));
      per.set(mcat, (per.get(mcat) ?? 0) + 1);
    }
  });
  const accepted = new Map<string, Set<number>>();
  for (const [w, owners] of matcher.vocabOwners) {
    const per = tally.get(w);
    const total = per ? [...per.values()].reduce((a, b) => a + b, 0) : 0;
    for (const mcat of owners) {
      const hits = per?.get(mcat) ?? 0;
      if (hits < VOCAB_MIN_HITS || hits / total < VOCAB_MIN_SHARE_OF_HITS) continue;
      let set = accepted.get(w);
      if (!set) accepted.set(w, (set = new Set()));
      set.add(mcat);
    }
  }
  const analysis: TableAnalysis = {
    sets,
    rarity,
    vocabOk: (w, mcat) => accepted.get(w)?.has(mcat) ?? false,
  };
  byIndex.set(matcher.words, analysis);
  return analysis;
}

/**
 * The keyword files are common to every MCAT; this picks the keywords that are about one MCAT, in code and
 * before any model call, so terms, labels, coverage and shares are all that MCAT's own. A keyword is the
 * MCAT's when its words score for it (the MCAT's name, its PMCAT, words only its listings use) and no other
 * MCAT scores much higher. A file with fewer than MIN_MCAT_KEYWORDS such keywords is left out for the MCAT.
 */
export function selectMcatKeywords(
  tables: KeywordTable[],
  m: McatScope,
): { tables: KeywordTable[]; selection: KeywordSelection[] } {
  const kept: KeywordTable[] = [];
  const selection = tables.map((t) => {
    const one = pickFromTable(t, m);
    if (one.table) kept.push(one.table);
    return one.selection;
  });
  return { tables: kept, selection };
}

interface TablePick {
  table: KeywordTable | null;
  selection: KeywordSelection;
}

// One pick per keyword table and MCAT: the page's counts, the preview and the run all ask for the same one.
const picks = new WeakMap<KeywordTable, WeakMap<McatScope, TablePick>>();

function pickFromTable(t: KeywordTable, m: McatScope): TablePick {
  let byMcat = picks.get(t);
  if (!byMcat) picks.set(t, (byMcat = new WeakMap()));
  const hit = byMcat.get(m);
  if (hit) return hit;
  const pick = computePick(t, m);
  byMcat.set(m, pick);
  return pick;
}

function computePick(t: KeywordTable, m: McatScope): TablePick {
  const matcher = m.matcher;
  let rows: KeywordTable["rows"] = [];
  if (matcher) {
    // Words are clustered around the MCATs' words (spelling variants count as the MCAT word) and scaled
    // by how rare they are in this file; see analyse().
    const { sets, rarity, vocabOk } = analyse(t, matcher);
    rows = t.rows.filter((_, i) => {
      const sc = matcher.score(sets[i]!, rarity, vocabOk);
      const mine = sc[matcher.index] ?? 0;
      return mine >= MIN_COVER && mine >= COMPETE * Math.max(...sc);
    });
  }
  const demand = rows.reduce((s, r) => s + r.demand, 0);
  const used = rows.length >= MIN_MCAT_KEYWORDS;
  const share =
    t.totalDemand > 0 ? demand / t.totalDemand : rows.length / Math.max(t.rows.length, 1);
  return {
    table: used
      ? {
          ...t,
          rows,
          totalDemand: demand,
          totalAction: rows.reduce((s, r) => s + r.action, 0),
        }
      : null,
    selection: {
      source: t.source,
      selected: rows.length,
      total: t.rows.length,
      demandPct: Math.round(share * 1000) / 10,
      used,
    },
  };
}

/** "Internal search: 210 of 4,000 keywords (31.2% of demand) · Google SERP: left out, only 6 about it". */
export function describeKeywordSelection(selection: KeywordSelection[]): string {
  return selection
    .map((s) =>
      s.used
        ? `${SOURCE_LABEL[s.source]}: ${s.selected.toLocaleString()} of ${s.total.toLocaleString()} keywords (${s.demandPct}% of demand)`
        : `${SOURCE_LABEL[s.source]}: left out, only ${s.selected} of ${s.total.toLocaleString()} keywords are about it`,
    )
    .join(" · ");
}
