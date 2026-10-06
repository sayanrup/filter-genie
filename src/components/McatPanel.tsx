import { useState } from "react";
import type { StepView } from "@/components/StepCards";
import type { McatSlice } from "@/lib/mcats";
import type { PipelineInputs, PipelineRun } from "@/lib/filter-gen";

export type McatStatus = "waiting" | "running" | "done" | "error";

/** One MCAT of a multi-MCAT run as the page tracks it. */
export interface McatState {
  name: string;
  inputs: PipelineInputs;
  status: McatStatus;
  steps: StepView[];
  run: PipelineRun | null;
  error: string;
}

const PILL: Record<McatStatus, { text: string; cls: string }> = {
  waiting: { text: "Waiting", cls: "bg-secondary text-muted-foreground" },
  running: { text: "Running", cls: "bg-primary-soft text-primary" },
  done: { text: "Done", cls: "bg-success-soft text-success" },
  error: { text: "Failed", cls: "bg-danger-soft text-destructive" },
};

/**
 * Shown before Generate when the product file holds several MCATs: what will be run, with a switch to
 * read the groups together as one category instead. The keyword files are common to every MCAT.
 */
export function McatPlan({
  slices,
  separate,
  onSeparateChange,
  hasKeywords,
  keywordLines,
  keywordCheck,
}: {
  slices: McatSlice[];
  separate: boolean;
  onSeparateChange: (v: boolean) => void;
  hasKeywords: boolean;
  /** Per MCAT: how many keywords were picked for it from the common files. */
  keywordLines: Record<string, string>;
  /** What the keyword file is about, and how many MCATs found keywords in it (null: no keyword file). */
  keywordCheck: { withKeywords: number; top: string[] } | null;
}) {
  // Closed until clicked: the list of MCATs and the notes under it are long. The switch stays in view.
  const [shown, setShown] = useState(false);
  const fewKeywords = Boolean(
    separate && keywordCheck && keywordCheck.withKeywords * 2 < slices.length,
  );
  return (
    <section className="panel mt-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          aria-expanded={shown}
          title={shown ? "Click to hide the MCATs" : "Click to see the MCATs"}
          className="min-w-0 rounded-md px-1 py-0.5 text-left hover:bg-accent/50"
        >
          <h2 className="font-display text-sm font-semibold">
            <span className="mr-1.5 inline-block w-3 text-[11px] text-muted-foreground">
              {shown ? "▼" : "▶"}
            </span>
            {slices.length} MCATs found in the product file
            {slices[0]?.inputs.mcat?.subcat
              ? ` · subcategory ${slices[0].inputs.mcat.subcat.id ?? ""} ${slices[0].inputs.mcat.subcat.name ?? ""}`
              : ""}
            {!shown && fewKeywords ? (
              <span className="ml-2 rounded-full bg-warning-soft px-2 py-0.5 align-middle text-[10px] font-semibold text-warning-foreground">
                ⚠ few keywords found
              </span>
            ) : null}
          </h2>
        </button>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={separate}
            onChange={(e) => onSeparateChange(e.target.checked)}
          />
          <span>
            <strong className="text-foreground">Run each MCAT separately</strong> (untick to read
            them together as one category)
          </span>
        </label>
      </div>
      {separate && shown ? (
        <>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Each MCAT gets its own filters and ISQ values, from its own listings.{" "}
            {hasKeywords
              ? "The SERP and internal keyword files are common to all MCATs: code picks the keywords about each MCAT (its name, its PMCAT, or words only its own listings use), so each MCAT's keyword numbers are its own. "
              : ""}
            Context and ranking are shared unless a line in them is just an MCAT's name (e.g.{" "}
            <span className="font-mono">## {slices[0]?.name}</span>), which starts that MCAT's own
            section.
          </p>
          {keywordCheck && keywordCheck.withKeywords * 2 < slices.length ? (
            <div className="mt-2 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-foreground">
              <strong>
                Only {keywordCheck.withKeywords} of {slices.length} MCATs found keywords in your
                keyword file.
              </strong>{" "}
              Its top keywords are: <span className="font-mono">{keywordCheck.top.join(", ")}</span>
              . If these aren't about
              {slices[0]?.inputs.mcat?.subcat?.name
                ? ` ${slices[0].inputs.mcat.subcat.name}`
                : " this product file's MCATs"}
              , it is the wrong keyword file for it: the MCATs with no keywords will be designed
              from their listings, context and ranking alone.
            </div>
          ) : null}
          <ul className="mt-2 divide-y divide-border text-xs">
            {slices.map((s) => (
              <li key={s.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                <span className="font-semibold">{s.name}</span>
                {s.inputs.mcat?.id ? (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    MCAT ID {s.inputs.mcat.id}
                  </span>
                ) : null}
                <span className="font-mono text-[11px] text-muted-foreground">
                  {s.inputs.listingRows.length.toLocaleString()} listings
                </span>
                {keywordLines[s.name] ? (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {keywordLines[s.name]}
                  </span>
                ) : null}
                {s.inputs.mcat?.pmcat ? (
                  <span className="text-[11px] text-muted-foreground">
                    PMCAT {s.inputs.mcat.pmcat.name}
                  </span>
                ) : null}
                {s.inputs.mcat?.notes.length ? (
                  <span className="text-[11px] text-warning">{s.inputs.mcat.notes[0]}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** The MCATs of a run as selectable cards: progress while running, then a switch between their results. */
export function McatPanel({
  items,
  active,
  onSelect,
  totals,
}: {
  items: McatState[];
  active: number;
  onSelect: (index: number) => void;
  /** Calls, tokens and cost across every MCAT, once there is something to add up. */
  totals: string;
}) {
  const done = items.filter((m) => m.status === "done").length;
  return (
    <section className="mt-6">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="font-display text-base font-semibold">MCATs</h2>
        <span className="font-mono text-[11px] text-muted-foreground">
          {done} of {items.length} done{totals ? ` · ${totals}` : ""}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((m, i) => {
          const filters = m.run?.result.filters ?? [];
          const running = m.steps.find((s) => s.status === "running");
          return (
            <button
              key={m.name}
              type="button"
              onClick={() => onSelect(i)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                i === active
                  ? "border-primary bg-primary-soft"
                  : "border-border bg-card hover:border-primary/50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate text-sm font-semibold">{m.name}</span>
                <span
                  className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${PILL[m.status].cls}`}
                >
                  {PILL[m.status].text}
                </span>
              </div>
              {m.inputs.mcat?.id ? (
                <div className="font-mono text-[10px] text-muted-foreground">
                  MCAT ID {m.inputs.mcat.id}
                </div>
              ) : null}
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                {m.status === "done"
                  ? `${filters.length} filters · ${filters.filter((f) => f.tier === "Tier 1").length} in Tier 1`
                  : m.status === "running"
                    ? (running?.label ?? "Starting…")
                    : m.status === "error"
                      ? m.error || "Failed"
                      : `${m.inputs.listingRows.length.toLocaleString()} listings`}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Previous / next MCAT with a result, and a list to jump to any of them. Sits beside the filter table so
 * the MCATs can be read one after another without going back up to the cards.
 */
export function McatNav({
  items,
  active,
  onSelect,
}: {
  items: McatState[];
  active: number;
  onSelect: (index: number) => void;
}) {
  // Only MCATs that have a result: one still waiting or running has nothing to show yet.
  const ready = items.flatMap((m, i) => (m.run ? [i] : []));
  const pos = ready.indexOf(active);
  const prev = pos > 0 ? ready[pos - 1] : undefined;
  const next = pos >= 0 && pos < ready.length - 1 ? ready[pos + 1] : undefined;
  const btn =
    "rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-semibold transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Move between MCATs">
      <button
        type="button"
        disabled={prev === undefined}
        onClick={() => prev !== undefined && onSelect(prev)}
        className={btn}
        title="Previous MCAT"
      >
        ◀ Prev
      </button>
      <select
        value={active}
        onChange={(e) => onSelect(Number(e.target.value))}
        aria-label="Jump to an MCAT"
        className="max-w-52 truncate rounded-md border border-border bg-card px-2 py-1.5 text-xs"
      >
        {ready.map((i) => (
          <option key={items[i]!.name} value={i}>
            {i + 1}. {items[i]!.name}
          </option>
        ))}
      </select>
      <span className="font-mono text-[11px] text-muted-foreground">
        {pos >= 0 ? pos + 1 : "–"}/{ready.length}
      </span>
      <button
        type="button"
        disabled={next === undefined}
        onClick={() => next !== undefined && onSelect(next)}
        className={btn}
        title="Next MCAT"
      >
        Next ▶
      </button>
    </div>
  );
}
