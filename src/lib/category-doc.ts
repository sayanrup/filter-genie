/* eslint-disable @typescript-eslint/no-explicit-any -- the document and the model's reply are untyped JSON, read field by field */
import type { FilterRow } from "./filter-gen";
import { parseSpecAudit, type Json } from "./mcat-context";
import { parseQuantity } from "./quantity";

/*
 * The category document (skill 15): per MCAT, the "Buyer Attracting Seller Specs" of its Seller & Buyer Spec
 * Audit — the seller spec questions and the options under each. It is used for two things only: to add to an
 * ISQ that is thin (one High value or none), and to say what unit and shape a measurement ISQ's values have
 * (and to supply them when the data's own are poor). It never decides which ISQs exist or their tier.
 *
 * It arrives through input 3, as either
 *   - the JSON saved by scripts/fetch-mcat-context.ts (`[{mcat_id, mcat_name, buyer_attracting_seller_specs:
 *     [{attribute, values}]}, …]`), which is then kept out of the model's context, or
 *   - the audit's own markdown (what "Load spec audit" puts there), which the model still reads as before.
 */

export interface DocIsq {
  name: string;
  values: string[];
}

export interface DocMcat {
  id: string;
  name: string;
  isqs: DocIsq[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const nameKey = (s: string) => norm(s).replace(/s$/, "");
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Where an entry keeps its ISQs, and an ISQ its name and values: the spellings the files in use have. */
const ISQ_LIST_KEYS = ["buyer_attracting_seller_specs", "isqs", "isq", "attributes", "specs"];
const ISQ_NAME_KEYS = ["attribute", "name", "spec", "spec_name", "isq"];
const ISQ_VALUE_KEYS = ["values", "options", "spec_values", "example_values"];

/** Only a number, or a range word and numbers: what the left piece of a value cut at a thousands comma is. */
const NUMBER_PIECE =
  /^(?:(?:up\s*to|upto|above|over|under|below|less\s*than|more\s*than|min\.?|max\.?)\s*)?[\d.,\s]*(?:(?:-|–|—|to)\s*[\d.,\s]*)?\d$/i;

/**
 * Puts back values that were cut at a thousands comma when their file was made: `"Up to 5", "000 sq ft"` is
 * "Up to 5,000 sq ft", and `"5", "001 - 10", "000 sq ft"` is "5,001 - 10,000 sq ft". A piece is joined to the one
 * before it when that one is only a number (or a range word and numbers) and this one starts with exactly three
 * digits that either begin with 0 or are followed by more text, so a plain list like 50, 100, 150 is left alone.
 * The Indian lakh form is put back too: `"1", "00,000 sq ft"` and `"1", "00", "000 sq ft"` are "1,00,000 sq ft".
 */
export function rejoinCutNumbers(values: string[]): string[] {
  /** The last group of a number: three digits that begin with 0 or carry on into text ("000 sq ft"). */
  const lastGroup = (v: string | undefined) =>
    v !== undefined && /^\d{3}(?!\d)/.test(v) && (/^0/.test(v) || v.length > 3);
  const out: string[] = [];
  values.forEach((v, i) => {
    const prev = out[out.length - 1];
    const joins =
      lastGroup(v) ||
      // A two-digit lakh group, with its thousands still attached ("00,000 sq ft") or in the next piece ("00").
      /^\d{2},\d{3}(?!\d)/.test(v) ||
      (/^\d{2}$/.test(v) && lastGroup(values[i + 1]));
    if (prev !== undefined && joins && NUMBER_PIECE.test(prev))
      out[out.length - 1] = `${prev},${v}`;
    else out.push(v);
  });
  return out;
}

function isqsOf(rows: unknown): DocIsq[] {
  const out: DocIsq[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as any;
    const name = ISQ_NAME_KEYS.map((k) => rec[k]).find((x) => typeof x === "string" && x.trim());
    const values = ISQ_VALUE_KEYS.map((k) => rec[k]).find((x) => Array.isArray(x));
    if (typeof name !== "string" || !Array.isArray(values)) continue;
    const seen = new Set<string>();
    const list: string[] = [];
    const texts = values.filter((v: unknown): v is string => typeof v === "string").map(clean);
    for (const v of rejoinCutNumbers(texts)) {
      if (!v || seen.has(norm(v))) continue;
      seen.add(norm(v));
      list.push(v);
    }
    if (list.length) out.push({ name: clean(name), values: list });
  }
  return out;
}

let lastParse: { text: string; list: DocMcat[] | null } | null = null;

/**
 * A pasted or uploaded input as the category document JSON, or null when it is anything else (plain text,
 * markdown, a JSON that lists no ISQs). An entry is an MCAT (`mcat_id`, `mcat_name`) with its ISQs under
 * `buyer_attracting_seller_specs` (saved-results/mcat-context.json), `isq` (saved-results/mcat-isq-attributes.json)
 * or `isqs`; each ISQ has a name (`attribute` / `name` / `spec`) and `values` (or `options`). A file can be an
 * array of entries, `{mcats: [...]}`, or one entry. Values cut at a thousands comma are put back together.
 */
export function parseCategoryDoc(text: string): DocMcat[] | null {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return null;
  if (lastParse?.text === text) return lastParse.list;
  let list: DocMcat[] | null = null;
  try {
    const data = JSON.parse(t);
    const items: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.mcats)
        ? data.mcats
        : data && typeof data === "object"
          ? [data]
          : [];
    const out: DocMcat[] = [];
    for (const m of items) {
      if (!m || typeof m !== "object") continue;
      const rows = ISQ_LIST_KEYS.map((k) => m[k]).find((x) => Array.isArray(x));
      if (!rows) continue;
      const isqs = isqsOf(rows);
      out.push({
        id: m.mcat_id == null ? "" : String(m.mcat_id).trim(),
        name: clean(String(m.mcat_name ?? "")),
        isqs,
      });
    }
    list = out.length ? out : null;
  } catch {
    list = null;
  }
  lastParse = { text, list };
  return list;
}

/** This run's MCAT in the document: by id, then by name; a document of one MCAT is that MCAT's. */
export function docEntryFor(
  list: DocMcat[],
  who: { id?: string | undefined; name?: string | undefined } | null,
): DocMcat | null {
  if (who?.id) {
    const hit = list.find((m) => m.id && m.id === who.id);
    if (hit) return hit;
  }
  if (who?.name) {
    const k = nameKey(who.name);
    const hit = list.find((m) => m.name && nameKey(m.name) === k);
    if (hit) return hit;
  }
  return list.length === 1 ? list[0]! : null;
}

/**
 * The same section out of audit markdown in the context ("# Name — Seller & Buyer Spec Audit" …
 * "## 1. Buyer Attracting Seller Specs"). With several audits in the text, the one whose "Mcat Id" or heading
 * is this run's MCAT; null when there is none.
 */
export function docFromAuditMarkdown(
  text: string,
  who: { id?: string | undefined; name?: string | undefined } | null,
): DocMcat | null {
  if (!/Buyer Attracting Seller Specs/i.test(text)) return null;
  const starts = [...text.matchAll(/^#\s+.*Seller\s*&\s*Buyer Spec Audit.*$/gim)].map(
    (m) => m.index ?? 0,
  );
  const chunks = starts.length
    ? starts.map((s, i) => text.slice(s, starts[i + 1] ?? text.length))
    : [text];
  const entries = chunks.map((chunk) => {
    const audit = parseSpecAudit(chunk.split(/\n## Glossary/i)[0]!) as Record<string, Json>;
    const id = typeof audit["mcat_id"] === "string" ? audit["mcat_id"] : "";
    const name = (
      chunk.match(/^#\s+(.*?)\s*(?:[—–-]+\s*)?Seller\s*&\s*Buyer Spec Audit/im)?.[1] ?? ""
    )
      .replace(/[—–-]+\s*$/, "")
      .trim();
    return { id, name, isqs: isqsOf(audit["buyer_attracting_seller_specs"]) };
  });
  const withIsqs = entries.filter((e) => e.isqs.length);
  return withIsqs.length ? docEntryFor(withIsqs, who) : null;
}

// ───────────────────────────── pairing ISQs and values with the document ─────────────────────────────

/** One of our ISQs paired with one of the document's, and our values paired with its values. */
export interface DocPair {
  filter: FilterRow;
  isq: DocIsq;
  /** Our value (as written on the filter) → the document's value that means the same. */
  values: Map<string, string>;
}

const MEASURE_WORD =
  /\b(area|size|dimensions?|length|width|breadth|height|thickness|diameter|depth|span)\b/gi;

/** The measurement words in an ISQ's name: "Cabin Dimensions" → ["size"], "Clear Span Width" → ["span", "width"]. */
function measureWords(name: string): string[] {
  const out: string[] = [];
  for (const m of name.matchAll(MEASURE_WORD)) {
    const w = m[0]
      .toLowerCase()
      .replace(/^dimensions?$/, "size")
      .replace("breadth", "width");
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

const words = (name: string) =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * The document ISQ that is the same measurement as this ISQ, found by name alone ("Size" ↔ "Cabin Size",
 * "Area" ↔ "Floor Area", "Wall Thickness" ↔ "Wall Panel Thickness"), so measurements never depend on the model
 * to be paired. The document ISQ must really hold quantities. Area and Size stand in for each other when the
 * document has only one of them. With several candidates, the one sharing the most name words; a tie is null.
 */
function measurementPair(f: FilterRow, doc: DocMcat, used: Set<DocIsq>): DocIsq | null {
  const mine = measureWords(f.name);
  if (!mine.length) return null;
  const holdsQuantities = (q: DocIsq) =>
    q.values.filter((v) => parseQuantity(v)).length >= Math.max(2, q.values.length / 2);
  const pool = doc.isqs.filter((q) => !used.has(q) && holdsQuantities(q));
  let candidates = pool.filter((q) => measureWords(q.name).some((w) => mine.includes(w)));
  if (!candidates.length && mine.some((w) => w === "area" || w === "size"))
    candidates = pool.filter((q) => measureWords(q.name).some((w) => w === "area" || w === "size"));
  if (candidates.length <= 1) return candidates[0] ?? null;
  const own = words(f.name);
  const scored = candidates
    .map((q) => ({ q, n: words(q.name).filter((w) => own.includes(w)).length }))
    .sort((a, b) => b.n - a.n);
  return scored[0]!.n !== scored[1]!.n ? scored[0]!.q : null;
}

/** The ISQs code pairs with the document itself, as measurements: these need no model call. */
export function measurementPairs(filters: FilterRow[], doc: DocMcat): Map<FilterRow, DocIsq> {
  const used = new Set<DocIsq>();
  const out = new Map<FilterRow, DocIsq>();
  for (const f of filters) {
    const isq = measurementPair(f, doc, used);
    if (!isq) continue;
    used.add(isq);
    out.set(f, isq);
  }
  return out;
}

/**
 * Measurements are paired by code first (measurementPairs). Then the model's pairs, checked: the filter and the document ISQ must exist, a document ISQ pairs with one filter,
 * and a value pair counts only when our value is one of the filter's and the other is one of that ISQ's — so
 * nothing can be invented. A filter the model left out (or a failed call: `data` null) is paired by code when
 * its name, or its listing spec's name, is the document ISQ's name ignoring case and punctuation, else with the
 * one unused document ISQ that shares the most values with it written the same (a tie pairs nothing).
 */
export function parseDocPairs(data: any, filters: FilterRow[], doc: DocMcat): DocPair[] {
  const byFilter = new Map(filters.map((f) => [norm(f.name), f]));
  const byIsq = new Map(doc.isqs.map((q) => [norm(q.name), q]));
  const used = new Set<DocIsq>();
  const out = new Map<FilterRow, DocPair>();

  const valuePairs = (f: FilterRow, isq: DocIsq, given: Record<string, unknown>) => {
    const ours = new Map(f.values.map((v) => [norm(v), v]));
    const theirs = new Map(isq.values.map((v) => [norm(v), v]));
    const pairs = new Map<string, string>();
    for (const [a, c] of Object.entries(given)) {
      const mine = ours.get(norm(a));
      const docValue = typeof c === "string" ? theirs.get(norm(c)) : undefined;
      if (mine && docValue && !pairs.has(mine)) pairs.set(mine, docValue);
    }
    for (const [k, mine] of ours)
      if (theirs.has(k) && !pairs.has(mine)) pairs.set(mine, theirs.get(k)!);
    return pairs;
  };

  for (const [f, isq] of measurementPairs(filters, doc)) {
    used.add(isq);
    out.set(f, { filter: f, isq, values: valuePairs(f, isq, {}) });
  }

  const list: any[] = Array.isArray(data?.matches) ? data.matches : [];
  for (const m of list) {
    const f = typeof m?.isq === "string" ? byFilter.get(norm(m.isq)) : undefined;
    const isq = typeof m?.doc === "string" ? byIsq.get(norm(m.doc)) : undefined;
    if (!f || !isq || used.has(isq) || out.has(f)) continue;
    used.add(isq);
    const given = m?.values && typeof m.values === "object" ? m.values : {};
    out.set(f, { filter: f, isq, values: valuePairs(f, isq, given) });
  }
  for (const f of filters) {
    if (out.has(f)) continue;
    let isq = [f.name, f.linked_listing_spec ?? ""]
      .map((n) => byIsq.get(norm(n)))
      .find((q) => q && !used.has(q));
    if (!isq) {
      const mine = new Set(f.values.map(norm).filter(Boolean));
      const scored = doc.isqs
        .filter((q) => !used.has(q))
        .map((q) => ({ q, n: q.values.filter((v) => mine.has(norm(v))).length }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n);
      if (scored[0] && scored[0].n !== scored[1]?.n) isq = scored[0].q;
    }
    if (!isq) continue;
    used.add(isq);
    out.set(f, { filter: f, isq, values: valuePairs(f, isq, {}) });
  }
  return [...out.values()];
}
