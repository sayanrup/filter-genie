import type { Evidence, FilterRow } from "@/lib/filter-gen";
import { SOURCE_LABEL } from "@/lib/data";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The full reasoning behind one filter row: its rationale in full, every evidence link it actually
 * resolved to, and — unlike the Evidence tab, which shows one dimension/spec table per category —
 * just the rows this specific filter draws its numbers from. Renders as an extra <tr> under the
 * filter's own row when expanded, so the richer rationale/interaction text this app now asks the
 * model for (see skill 10) is readable where it's read, not only in a separate tab.
 */
export function FilterDetailRow({
  filter,
  evidence,
  colSpan,
}: {
  filter: FilterRow;
  evidence: Evidence;
  colSpan: number;
}) {
  const dim = filter.linked_dimension
    ? evidence.aggregation?.dimensions.find((d) => norm(d.name) === norm(filter.linked_dimension!))
    : undefined;
  const spec = filter.linked_listing_spec
    ? evidence.listing?.fields.find((f) => norm(f.key) === norm(filter.linked_listing_spec!))
    : undefined;
  const sources = Object.keys(dim?.bySource ?? {}) as Array<keyof typeof SOURCE_LABEL>;

  return (
    <tr className="border-b border-border bg-secondary/40 last:border-0">
      <td colSpan={colSpan} className="px-3 py-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h4 className="label-caps mb-1.5">Full rationale</h4>
            <p className="text-xs leading-relaxed text-foreground">{filter.rationale}</p>
            {filter.needs_new_isq ? (
              <p className="mt-2 text-xs text-destructive">
                ⚠ Needs a new ISQ — {filter.isq_note || "not captured on listings today."}
              </p>
            ) : null}
          </div>

          <div className="grid gap-3">
            {dim ? (
              <div>
                <h4 className="label-caps mb-1.5">
                  Keyword evidence — <span className="normal-case">{dim.name}</span>
                </h4>
                <div className="mb-1.5 flex flex-wrap gap-x-3 font-mono text-[10px] text-muted-foreground">
                  {sources.map((s) => {
                    const st = dim.bySource[s];
                    return st ? (
                      <span key={s}>
                        {SOURCE_LABEL[s]}: coverage {st.coverage}% · top value {st.topShare}%
                      </span>
                    ) : null;
                  })}
                </div>
                <div className="flex flex-wrap gap-1">
                  {dim.values.slice(0, 8).map((v) => (
                    <span
                      key={v.value}
                      className="rounded border border-border bg-card px-1.5 py-0.5 text-[11px]"
                      title={sources
                        .map((s) => {
                          const b = v.bySource[s];
                          return b ? `${SOURCE_LABEL[s]}: ${b.demand} demand, ${b.share}% of dimension` : null;
                        })
                        .filter(Boolean)
                        .join(" · ")}
                    >
                      {v.value}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {spec ? (
              <div>
                <h4 className="label-caps mb-1.5">
                  Listing evidence — <span className="normal-case">{spec.key}</span>
                </h4>
                <p className="mb-1.5 font-mono text-[10px] text-muted-foreground">
                  filled on {spec.fillPct}% of listings · {spec.distinct} distinct value
                  {spec.distinct === 1 ? "" : "s"}
                </p>
                <div className="flex flex-wrap gap-1">
                  {spec.top.slice(0, 8).map(([v, n]) => (
                    <span
                      key={v}
                      className="rounded border border-border bg-card px-1.5 py-0.5 text-[11px]"
                    >
                      {v} <span className="text-muted-foreground">({n})</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {!dim && !spec ? (
              <p className="text-xs text-muted-foreground">
                No keyword dimension or listing spec is linked to this filter — its tier and
                confidence rest on the context document and/or CM ranking alone.
              </p>
            ) : null}
          </div>
        </div>
      </td>
    </tr>
  );
}
