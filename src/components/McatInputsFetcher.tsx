import { useEffect, useRef, useState } from "react";

/** The IndiaMART APIs only answer on the IndiaMART network, so only a locally run app can reach them. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PARALLEL = 4;

export interface WantedMcat {
  id: string;
  name: string;
  listings: number;
  pmcat?: string;
}

type Json = unknown;

/** Inputs 3 and 4 as scripts/fetch-mcat-context.ts and scripts/fetch-isq.ts write their upload files. */
interface Fetched {
  context: { head: Record<string, Json>; isq: Json[] }[];
  specs: { head: Record<string, Json>; isqs: Json[] }[];
  noAudit: string[];
  noIsqs: string[];
  failed: string[];
}

/** One MCAT per block, one ISQ per line: the upload files' layout. */
function uploadJson(entries: { head: Record<string, Json>; rows: Json[] }[], key: string): string {
  const blocks = entries.map(({ head, rows }) => {
    const lines = rows.map((r) => `    ${JSON.stringify(r)}`);
    return `  {${JSON.stringify(head).slice(1, -1)}, "${key}": [\n${lines.join(",\n")}\n  ]}`;
  });
  return `[\n${blocks.join(",\n")}\n]\n`;
}

const contextJson = (f: Fetched) =>
  uploadJson(
    f.context.map((e) => ({ head: e.head, rows: e.isq })),
    "isq",
  );
const specsJson = (f: Fetched) =>
  uploadJson(
    f.specs.map((e) => ({ head: e.head, rows: e.isqs })),
    "isqs",
  );

function download(name: string, body: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

class Unreachable extends Error {}

async function getJson(
  url: string,
): Promise<{ ok: boolean; status: number; body: Record<string, Json> }> {
  const resp = await fetch(url);
  const body = ((await resp.json().catch(() => ({}))) ?? {}) as Record<string, Json>;
  // 502: the server couldn't reach the IndiaMART API; 401/500: the token. Every other MCAT would fail too.
  if ([401, 500, 502].includes(resp.status))
    throw new Unreachable(String(body["error"] ?? `Request failed (${resp.status})`));
  return { ok: resp.ok, status: resp.status, body };
}

/**
 * The MCATs of the product file (input 5) → their Seller & Buyer Spec Audits (input 3, /api/mcat-context) and
 * live ISQs (input 4, /api/mcat-isq), as the fetch scripts' upload files, put into inputs 3 and 4.
 */
export function McatInputsFetcher({
  mcats,
  subcatId,
  hasInputs,
  onFetched,
}: {
  mcats: WantedMcat[];
  subcatId?: string | undefined;
  /** Inputs 3 or 4 already hold text, which fetching replaces. */
  hasInputs: boolean;
  onFetched: (context: string, specs: string) => void;
}) {
  const [local, setLocal] = useState(false);
  // Decided after mount so the server-rendered page and the first client render match.
  useEffect(() => setLocal(LOCAL_HOSTS.has(window.location.hostname)), []);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState("");
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const stop = useRef(false);
  const ids = mcats.map((m) => m.id).join(",");
  // A different product file: what was fetched belongs to the old one.
  useEffect(() => {
    setFetched(null);
    setError("");
  }, [ids]);

  if (!mcats.length) return null;

  async function run() {
    if (
      hasInputs &&
      !window.confirm("Replace what is in inputs 3 and 4 with what the APIs return?")
    )
      return;
    setBusy(true);
    setDone(0);
    setError("");
    setFetched(null);
    stop.current = false;
    const byId = new Map<
      string,
      {
        audit?: Record<string, Json>;
        isqs?: Json[];
        noAudit?: boolean;
        noIsqs?: boolean;
        failed?: string;
      }
    >();
    let next = 0;
    let count = 0;
    const worker = async () => {
      while (!stop.current && next < mcats.length) {
        const m = mcats[next++]!;
        const entry: NonNullable<ReturnType<typeof byId.get>> = {};
        byId.set(m.id, entry);
        try {
          const [c, q] = await Promise.all([
            getJson(`/api/mcat-context?mcat_id=${m.id}`),
            getJson(`/api/mcat-isq?mcat_id=${m.id}`),
          ]);
          if (c.ok) entry.audit = c.body;
          else entry.noAudit = true;
          if (q.ok && q.body["status"] === "ok") entry.isqs = q.body["isqs"] as Json[];
          else if (q.ok) entry.noIsqs = true;
          else entry.failed = String(q.body["error"] ?? q.status);
        } catch (e) {
          stop.current = true;
          setError((e as Error).message);
        }
        setDone(++count);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, mcats.length) }, worker));
    setBusy(false);
    if (stop.current) {
      setError((e) => e || "Stopped. Nothing was put in inputs 3 and 4.");
      return;
    }

    const head = (m: WantedMcat, name?: Json) => ({
      mcat_name: name ?? m.name,
      mcat_id: m.id,
      ...(m.pmcat ? { pmcat: m.pmcat } : {}),
      listings: m.listings,
    });
    const label = (m: WantedMcat) => `${m.name} (${m.id})`;
    const result: Fetched = { context: [], specs: [], noAudit: [], noIsqs: [], failed: [] };
    for (const m of mcats) {
      const e = byId.get(m.id) ?? {};
      if (e.audit)
        result.context.push({
          head: head(m, e.audit["mcat_name"]),
          isq: (e.audit["buyer_attracting_seller_specs"] as Json[] | undefined) ?? [],
        });
      if (e.isqs) result.specs.push({ head: head(m), isqs: e.isqs });
      if (e.noAudit) result.noAudit.push(label(m));
      if (e.noIsqs) result.noIsqs.push(label(m));
      if (e.failed) result.failed.push(`${label(m)}: ${e.failed}`);
    }
    setFetched(result);
    onFetched(
      result.context.length ? contextJson(result) : "",
      result.specs.length ? specsJson(result) : "",
    );
  }

  const prefix = subcatId ? `subcat${subcatId}` : "mcats";
  const button =
    "rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground transition-colors hover:bg-accent disabled:opacity-50";

  return (
    <section className="panel mt-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-sm font-semibold">
          Inputs 3 and 4 from the IndiaMART APIs
        </h2>
        <button
          type="button"
          onClick={() => void run()}
          disabled={!local || busy}
          className={`ml-auto ${button}`}
          title={
            local ? undefined : "Only in the app run locally on the IndiaMART network (npm run dev)"
          }
        >
          {busy
            ? `Fetching… ${done}/${mcats.length}`
            : `Fetch inputs 3 & 4 for ${mcats.length} MCATs`}
        </button>
        {busy ? (
          <button type="button" onClick={() => (stop.current = true)} className={button}>
            Stop
          </button>
        ) : null}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {local
          ? "Takes the MCAT ids from the product file (input 5), fetches each MCAT's Seller & Buyer Spec Audit (input 3) and live ISQs (input 4), and puts them in inputs 3 and 4."
          : "The IndiaMART APIs only answer on the IndiaMART network: run the app locally there (npm run dev) to use this."}
      </p>
      {error ? <p className="mt-1.5 font-mono text-[11px] text-destructive">{error}</p> : null}
      {fetched ? (
        <div className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
          <p>
            <span className="text-success">
              Spec audit for {fetched.context.length} of {mcats.length} MCATs, live ISQs for{" "}
              {fetched.specs.length}.
            </span>{" "}
            {fetched.context.length ? (
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => download(`${prefix}mcatforupload.json`, contextJson(fetched))}
              >
                Download input 3
              </button>
            ) : null}{" "}
            {fetched.specs.length ? (
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => download(`${prefix}isqforupload.json`, specsJson(fetched))}
              >
                Download input 4
              </button>
            ) : null}
          </p>
          {fetched.noAudit.length ? <p>No spec audit: {fetched.noAudit.join(", ")}</p> : null}
          {fetched.noIsqs.length ? <p>No live ISQs: {fetched.noIsqs.join(", ")}</p> : null}
          {fetched.failed.length ? (
            <p className="text-destructive">
              Live ISQs failed (fetch again to retry): {fetched.failed.join("; ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
