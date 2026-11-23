/**
 * The MCATs a fetch script is asked for (fetch-mcat-context.ts, fetch-isq.ts): ids given on the command
 * line, or files holding
 *   - the MCAT list copied from the app, which also gives each MCAT's name, listings and PMCAT:
 *       Prefabricated Buildings
 *       MCAT ID 35589
 *       32 listings
 *       PMCAT Prefabricated Buildings
 *   - JSON with MCATs (`[{mcat_id, mcat_name, pmcat, listings}]` or `{mcats: [...]}`), such as the app's
 *     "ISQs + confidence" export or a file these scripts wrote;
 *   - one id per line, or in the first column of a CSV.
 */
import { readFileSync } from "node:fs";

export interface Wanted {
  id: string;
  name?: string;
  listings?: number;
  pmcat?: string;
}

function fromJson(text: string): Wanted[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const mcats = (data as { mcats?: unknown } | null)?.mcats;
  const items: unknown[] = Array.isArray(data) ? data : Array.isArray(mcats) ? mcats : [];
  const found: Wanted[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const id = String(m["mcat_id"] ?? "").trim();
    if (!/^\d+$/.test(id)) continue;
    const entry: Wanted = { id };
    if (typeof m["mcat_name"] === "string" && m["mcat_name"].trim())
      entry.name = m["mcat_name"].trim();
    const pmcat = m["pmcat"];
    const pmcatName =
      typeof pmcat === "string" ? pmcat : (pmcat as { name?: unknown } | null)?.name;
    if (typeof pmcatName === "string" && pmcatName.trim()) entry.pmcat = pmcatName.trim();
    if (typeof m["listings"] === "number") entry.listings = m["listings"];
    found.push(entry);
  }
  return found;
}

/** MCATs out of a file's text: JSON, the app's MCAT list ("MCAT ID 35589"), or one id per line. */
export function parseMcatList(text: string): Wanted[] {
  if (/^\s*[[{]/.test(text)) {
    const json = fromJson(text);
    if (json) return json;
  }
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
    // The list can have a line ("Internal search: …") between the listings and the PMCAT.
    for (const next of lines.slice(i + 1, i + 5)) {
      if (/^MCAT ID\s*\d+$/i.test(next)) break;
      const listings = next.match(/^(\d+) listings?$/i)?.[1];
      const pmcat = next.match(/^PMCAT\s+(.+)$/i)?.[1];
      if (listings) entry.listings = Number(listings);
      if (pmcat) entry.pmcat = pmcat;
    }
    found.push(entry);
  });
  return found;
}

/** Every MCAT the arguments name (ids, or files to read), each once, in the order given. */
export function readMcatList(inputs: string[]): Wanted[] {
  const seen = new Set<string>();
  return inputs
    .flatMap((a) => (/^\d+$/.test(a) ? [{ id: a }] : parseMcatList(readFileSync(a, "utf8"))))
    .filter((w) => !seen.has(w.id) && seen.add(w.id));
}
