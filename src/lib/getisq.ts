/**
 * IndiaMART's getisq API, for the app's server (/api/mcat-isq): an MCAT's live ISQs (the buyer-form spec
 * questions and their options), cut to what input 4 takes: `[{name, values}]`, values in the form's order.
 * The same reading as scripts/fetch-isq.ts (which stays the command-line way to do it). The API is internal
 * (plain http, office network only) and needs GETISQ_TOKEN on the server.
 */

export const GETISQ_API = "http://leads.imutils.com/wservce/buyleads/getisq/";

/** Questions every buyer form asks: not product attributes, so not in input 4. */
const BUYER_FORM =
  /^(quantity|quantity unit|i am interested in|finance\s*\/?\s*loan requirement|business type)$/i;

type Row = Record<string, unknown>;

export interface LiveIsq {
  name: string;
  values: string[];
}

export interface McatLiveIsqs {
  mcat_id: string;
  /** "no_isqs": the API knows no ISQs for this MCAT (or doesn't know the id). */
  status: "ok" | "no_isqs";
  isqs: LiveIsq[];
}

/** The API refused the token: every other MCAT would fail the same way. */
export class GetisqTokenError extends Error {}

const list = (s: unknown) => (s == null || s === "" ? [] : String(s).split(","));

/** One ISQ row's active values in the form's order, with values cut at a thousands or lakh comma joined back. */
function valuesOf(row: Row): string[] {
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
  return ids
    .map((_, i) => ({
      value: (pieces[i] ?? "").trim(),
      priority: Number(priority[i]) || Infinity,
      active: !status[i] || status[i] === "1",
    }))
    .filter((o) => o.active && o.value && o.value.toLowerCase() !== "none")
    .sort((a, b) => a.priority - b.priority)
    .map((o) => o.value);
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

/** One MCAT's live product ISQs. Throws GetisqTokenError, or the fetch error when the API can't be reached. */
export async function fetchLiveIsqs(
  mcatId: string,
  token: string,
  signal?: AbortSignal,
): Promise<McatLiveIsqs> {
  const url = `${GETISQ_API}?${new URLSearchParams({ modid: "DIR", token, mcatid: mcatId, cat_type: "3" })}`;
  const resp = await fetch(url, signal ? { signal } : {});
  const raw = (await resp.json()) as Row & { RESPONSE?: Row };
  // A bad token comes back wrapped in RESPONSE; everything else at the top level.
  const body = raw.RESPONSE ?? raw;
  const code = String(body["CODE"] ?? resp.status);
  const message = typeof body["MESSAGE"] === "string" ? body["MESSAGE"] : undefined;
  if (code === "401") throw new GetisqTokenError(`getisq API: ${message ?? "token refused"}`);
  // "DATA NOT FOUND" (404) is an MCAT without ISQs, or an id the API doesn't know.
  if (code !== "200" && code !== "404")
    throw new Error(`getisq API answered ${code}${message ? `: ${message}` : ""}`);
  const isqs = rowsOf(body["DATA"])
    .filter((r) => r["IM_SPEC_MASTER_STATUS"] === "1")
    .map((r) => ({ name: String(r["IM_SPEC_MASTER_DESC"] ?? "").trim(), values: valuesOf(r) }))
    .filter((q) => q.name && !BUYER_FORM.test(q.name) && q.values.length);
  return { mcat_id: mcatId, status: isqs.length ? "ok" : "no_isqs", isqs };
}
