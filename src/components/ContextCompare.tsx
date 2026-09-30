import type { ContextComparison, RefCoverage } from "@/lib/compare";

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="panel min-w-40 flex-1 px-4 py-3">
      <div className="font-display text-2xl font-bold">{value}</div>
      <div className="text-xs font-medium">{label}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{note}</div>
    </div>
  );
}

function Names({ title, names, tone }: { title: string; names: string[]; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="label-caps mb-1.5">
        {title} ({names.length})
      </div>
      {names.length ? (
        <div className="flex flex-wrap gap-1.5">
          {names.map((n) => (
            <span key={n} className={`rounded-md bg-secondary px-2 py-1 text-xs ${tone ?? ""}`}>
              {n}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">none</span>
      )}
    </div>
  );
}

function RefBlock({ title, cov }: { title: string; cov: RefCoverage }) {
  const p = cov.reference ? Math.round((cov.covered.length / cov.reference) * 100) : 0;
  return (
    <div className="panel px-4 py-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h4 className="font-display text-sm font-semibold">{title}</h4>
        <span className="font-mono text-xs text-muted-foreground">
          {cov.covered.length}/{cov.reference} of your ISQs found · {p}%
        </span>
      </div>
      <div className="mb-3 h-2 overflow-hidden rounded-full bg-secondary">
        <div className="h-full bg-success" style={{ width: `${p}%` }} />
      </div>
      <div className="grid gap-3">
        <Names title="Missed (you gave it, the run didn't)" names={cov.missed} />
        <Names title="Extra (run proposed, not in your list)" names={cov.extra} />
      </div>
    </div>
  );
}

/** How alike the with- and without-context filters (ISQs) are, and how each matches the ISQs you gave. */
export function Similarity({ cmp }: { cmp: ContextComparison }) {
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-3">
        <Stat
          label="Overlap"
          value={`${cmp.overlapPct}%`}
          note={`${cmp.shared.length} filters in both runs, of all distinct filters`}
        />
        <Stat
          label="Found without context"
          value={`${cmp.recallPct}%`}
          note="of the with-context filters, the no-context run also produced"
        />
        <Stat
          label="Same tier"
          value={cmp.shared.length ? `${cmp.sameTierPct}%` : "—"}
          note="of shared filters, given the same tier in both runs"
        />
      </div>

      {cmp.refWith && cmp.refWithout ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <RefBlock title="Without context vs your ISQs" cov={cmp.refWithout} />
          <RefBlock title="With context vs your ISQs" cov={cmp.refWith} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Add your ISQs in the spec ranking input to also see how each run matches them.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Names title="Only WITH context" names={cmp.onlyWith} />
        <Names title="Only WITHOUT context" names={cmp.onlyWithout} />
      </div>

      {cmp.shared.length ? (
        <div className="overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-3">Without context</th>
                <th className="py-1 pr-3">Tier</th>
                <th className="py-1 pr-3">With context</th>
                <th className="py-1">Tier</th>
              </tr>
            </thead>
            <tbody>
              {cmp.shared.map((s) => (
                <tr key={`${s.without}|${s.withCtx}`} className="border-t border-border">
                  <td className="py-1 pr-3">{s.without}</td>
                  <td className="py-1 pr-3 font-mono">{s.tierWithout}</td>
                  <td className="py-1 pr-3">{s.withCtx}</td>
                  <td
                    className={`py-1 font-mono ${s.tierWith === s.tierWithout ? "" : "text-warning"}`}
                  >
                    {s.tierWith}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
