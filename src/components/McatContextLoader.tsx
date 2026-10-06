import { useEffect, useState } from "react";

/** The context API only answers on the IndiaMART network, so only a locally run app can reach it. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * MCAT id → its Seller & Buyer Spec Audit from IndiaMART's context API, via /api/mcat-context.
 * Hands the audit text to the category context input. Hidden on the hosted (Lovable) site, where
 * the server can't reach the API.
 */
export function McatContextLoader({ onLoad }: { onLoad: (markdown: string) => void }) {
  const [id, setId] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Decided after mount so the server-rendered page and the first client render match.
  const [local, setLocal] = useState(false);
  useEffect(() => setLocal(LOCAL_HOSTS.has(window.location.hostname)), []);
  const mcatId = id.trim();

  if (!local) return null;

  async function load() {
    if (!/^\d+$/.test(mcatId)) {
      setStatus({ ok: false, message: "Enter a numeric MCAT id." });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const resp = await fetch(`/api/mcat-context?mcat_id=${mcatId}&format=markdown`);
      if (!resp.ok) {
        const err = (await resp.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error ?? `Request failed (${resp.status})`);
      }
      const markdown = await resp.text();
      onLoad(markdown);
      const title = markdown.match(/^# (.+?) — /)?.[1] ?? `MCAT ${mcatId}`;
      setStatus({ ok: true, message: `Loaded the spec audit for ${title} (${mcatId}).` });
    } catch (e) {
      setStatus({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          className="field min-w-0 flex-1"
          placeholder="MCAT id, e.g. 135712"
          aria-label="MCAT id"
          value={id}
          onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load();
          }}
        />
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          className="shrink-0 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          {busy ? "Loading…" : "Load spec audit"}
        </button>
      </div>
      <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
        {status ? (
          <span className={status.ok ? "text-success" : "text-destructive"}>{status.message} </span>
        ) : null}
        {/^\d+$/.test(mcatId) ? (
          <a
            href={`/api/mcat-context?mcat_id=${mcatId}`}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            View JSON
          </a>
        ) : null}
      </p>
    </div>
  );
}
