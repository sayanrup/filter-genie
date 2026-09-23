import { useMemo, useState } from "react";
import type { FilterResult, FilterRow } from "@/lib/filter-gen";

type Device = "desktop" | "mobile";

const TIER_ORDER: Record<string, number> = { "Tier 1": 0, "Tier 2": 1, "Tier 3": 2 };

function sortFilters(filters: FilterRow[]) {
  return [...filters].sort(
    (a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) || a.rank - b.rank,
  );
}

function pick<T>(arr: T[], i: number): T | undefined {
  return arr.length ? arr[i % arr.length] : undefined;
}

interface DemoProduct {
  name: string;
  price: number;
  unit: string;
  seller: string;
  city: string;
  specLabel: string;
  specValue: string;
  hue: number;
}

function buildProducts(result: FilterResult): DemoProduct[] {
  const category = result.category_name?.trim() || "Product";
  const filters = sortFilters(result.filters);
  const primary = filters.find((f) => (f.values ?? []).length > 1) ?? filters[0];
  const secondary = filters.find((f) => f !== primary && (f.values ?? []).length > 1);
  const brands = ["Shree", "Aarav", "Kesar", "Navdeep", "Vikas", "Jyoti", "Rathi", "Sanghvi"];
  const cities = ["Delhi", "Mumbai", "Ahmedabad", "Jaipur", "Noida", "Pune", "Surat", "Indore"];
  const units = ["Piece", "Bag", "Kg", "Set", "Box"];

  return Array.from({ length: 8 }, (_, i) => {
    const variant = pick(primary?.values ?? [], i);
    const label = secondary?.name ?? primary?.name ?? "Specification";
    const value = pick(secondary?.values ?? primary?.values ?? [], i + 1) ?? "Standard";
    return {
      name: `${variant ? `${variant} ` : ""}${category}`.replace(/\s+/g, " ").trim(),
      price: 120 + ((i * 137) % 900),
      unit: pick(units, i)!,
      seller: `${pick(brands, i)} Enterprises`,
      city: pick(cities, i)!,
      specLabel: label,
      specValue: String(value),
      hue: (i * 47 + 195) % 360,
    };
  });
}

function ProductThumb({ hue, label }: { hue: number; label: string }) {
  return (
    <div
      className="flex h-36 items-center justify-center rounded-md text-center text-[10px] font-semibold uppercase tracking-wider"
      style={{
        background: `linear-gradient(140deg, hsl(${hue} 55% 92%), hsl(${(hue + 40) % 360} 60% 80%))`,
        color: `hsl(${hue} 45% 32%)`,
      }}
    >
      <span className="px-3">{label}</span>
    </div>
  );
}

function FilterChip({
  filter,
  open,
  onToggle,
  selected,
  onSelect,
}: {
  filter: FilterRow;
  open: boolean;
  onToggle: () => void;
  selected: string[];
  onSelect: (value: string) => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
          selected.length
            ? "border-primary bg-primary-soft text-primary"
            : "border-border bg-card text-foreground hover:border-primary/50"
        }`}
      >
        {filter.name}
        {selected.length ? <span className="font-bold">· {selected.length}</span> : null}
        <span className="text-[9px] opacity-60">▼</span>
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-20 mt-1.5 max-h-64 w-56 overflow-auto rounded-lg border border-border bg-card p-2 shadow-lg">
          <p className="label-caps mb-1 px-1">{filter.ui_pattern}</p>
          {(filter.values ?? []).length ? (
            (filter.values ?? []).map((v) => (
              <label
                key={v}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent"
              >
                <input type="checkbox" checked={selected.includes(v)} onChange={() => onSelect(v)} />
                <span>{v}</span>
              </label>
            ))
          ) : (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">No values suggested</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SearchPreview({
  result,
  initialDevice = "desktop",
}: {
  result: FilterResult;
  initialDevice?: Device;
}) {
  const [device, setDevice] = useState<Device>(initialDevice);
  const [openChip, setOpenChip] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selections, setSelections] = useState<Record<string, string[]>>({});

  const filters = useMemo(() => sortFilters(result.filters), [result]);
  const products = useMemo(() => buildProducts(result), [result]);
  const category = result.category_name?.trim() || "Product";
  const primaryFilters = filters.slice(0, 5);
  const restFilters = filters.slice(5);

  function toggleValue(filterName: string, value: string) {
    setSelections((prev) => {
      const current = prev[filterName] ?? [];
      return {
        ...prev,
        [filterName]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
      };
    });
  }

  const activeCount = Object.values(selections).reduce((n, v) => n + v.length, 0);

  const results = (
    <div
      className={
        device === "desktop"
          ? "grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3"
          : "grid grid-cols-2 gap-2.5 p-3"
      }
    >
      {products.slice(0, device === "desktop" ? 6 : 4).map((p, i) => (
        <article key={i} className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="p-2">
            <ProductThumb hue={p.hue} label={p.name} />
          </div>
          <div className="px-3 pb-3">
            <h4 className="line-clamp-2 text-xs font-semibold text-primary">{p.name}</h4>
            <p className="mt-1 text-sm font-bold">
              ₹{p.price}
              <span className="text-[11px] font-normal text-muted-foreground">/{p.unit}</span>
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {p.seller} · {p.city}
            </p>
            <button
              type="button"
              className="mt-2 w-full rounded-md bg-primary px-3 py-1.5 text-[11px] font-semibold text-primary-foreground"
            >
              Contact Supplier
            </button>
            <div className="mt-2 flex items-center justify-between border-t border-border pt-1.5 text-[10px]">
              <span className="text-muted-foreground">{p.specLabel}</span>
              <span className="font-semibold">{p.specValue}</span>
            </div>
          </div>
        </article>
      ))}
    </div>
  );

  return (
    <div className="panel p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="font-display text-sm font-semibold">Demo search page</h3>
        <p className="text-xs text-muted-foreground">
          See how the filters would sit on a live listing page.
        </p>
        <div className="ml-auto inline-flex rounded-lg border border-border bg-secondary p-0.5">
          {(["desktop", "mobile"] as Device[]).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => {
                setDevice(d);
                setOpenChip(null);
                setSheetOpen(false);
              }}
              className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition-colors ${
                device === d ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className={device === "mobile" ? "flex justify-center" : ""}>
        <div
          className={`overflow-hidden rounded-xl border border-border bg-secondary ${
            device === "mobile" ? "w-[380px] max-w-full" : "w-full"
          }`}
        >
          {/* search header */}
          <div className="border-b border-border bg-card px-4 py-3">
            <div className="flex items-center gap-2">
              <h4 className="truncate font-display text-base font-bold">
                {category} <span className="font-normal text-muted-foreground">near Delhi</span>
              </h4>
              {device === "desktop" ? (
                <span className="ml-auto text-[11px] text-primary underline">Advanced Search</span>
              ) : null}
            </div>
          </div>

          {/* filter bar */}
          {device === "desktop" ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-3">
              <span className="rounded-full border border-border px-2.5 py-1.5 text-xs">⚙</span>
              <span className="rounded-full border border-border px-3 py-1.5 text-xs font-medium">◎ Near Me</span>
              <span className="rounded-full border border-border px-3 py-1.5 text-xs font-medium">Delhi ▾</span>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border-2 border-destructive/60 p-1.5">
                {primaryFilters.map((f) => (
                  <FilterChip
                    key={f.name}
                    filter={f}
                    open={openChip === f.name}
                    onToggle={() => setOpenChip(openChip === f.name ? null : f.name)}
                    selected={selections[f.name] ?? []}
                    onSelect={(v) => toggleValue(f.name, v)}
                  />
                ))}
              </div>
              {restFilters.length ? (
                <span className="text-[11px] text-muted-foreground">
                  +{restFilters.length} more in “All filters”
                </span>
              ) : null}
            </div>
          ) : (
            <div className="border-b border-border bg-card px-3 py-2.5">
              <div className="flex gap-2 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => setSheetOpen(true)}
                  className="flex shrink-0 items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-semibold"
                >
                  ⚙ Filters{activeCount ? ` (${activeCount})` : ""}
                </button>
                {primaryFilters.map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    onClick={() => setSheetOpen(true)}
                    className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium ${
                      (selections[f.name] ?? []).length
                        ? "border-primary bg-primary-soft text-primary"
                        : "border-border"
                    }`}
                  >
                    {f.name} ▾
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeCount ? (
            <div className="flex flex-wrap items-center gap-1.5 bg-card px-4 py-2">
              {Object.entries(selections).flatMap(([name, vals]) =>
                vals.map((v) => (
                  <span
                    key={`${name}-${v}`}
                    className="flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] text-primary"
                  >
                    {v}
                    <button type="button" onClick={() => toggleValue(name, v)} aria-label={`Remove ${v}`}>
                      ×
                    </button>
                  </span>
                )),
              )}
              <button
                type="button"
                onClick={() => setSelections({})}
                className="text-[11px] text-muted-foreground underline"
              >
                Clear all
              </button>
            </div>
          ) : null}

          {results}

          {/* mobile filter sheet */}
          {device === "mobile" && sheetOpen ? (
            <div className="border-t border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <h5 className="font-display text-sm font-semibold">All filters</h5>
                <button
                  type="button"
                  onClick={() => setSheetOpen(false)}
                  className="ml-auto text-xs text-muted-foreground"
                >
                  Close
                </button>
              </div>
              <div className="max-h-80 overflow-auto p-3">
                {filters.map((f) => (
                  <div key={f.name} className="mb-3">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-xs font-semibold">{f.name}</span>
                      <span className="label-caps ml-auto">{f.tier}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(f.values ?? []).slice(0, 12).map((v) => {
                        const on = (selections[f.name] ?? []).includes(v);
                        return (
                          <button
                            key={v}
                            type="button"
                            onClick={() => toggleValue(f.name, v)}
                            className={`rounded-full border px-2.5 py-1 text-[11px] ${
                              on ? "border-primary bg-primary-soft text-primary" : "border-border bg-secondary"
                            }`}
                          >
                            {v}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
