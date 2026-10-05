import { useEffect, useState } from "react";
import { toKeywordTable, type Row } from "./data";
import { estimateRun, previewPrompts, type RunEstimate } from "./filter-gen";
import { describeKeywordSelection, selectMcatKeywords, type McatSlice } from "./mcats";
import type { KeywordTable } from "./data";

/** What the page shows before Generate for a product file with many MCATs. */
export interface McatPlanData {
  /** Per MCAT, the keywords picked for it from the common files; null when there is no keyword file. */
  keywords: {
    lines: Record<string, string>;
    /** MCATs that found enough keywords, and what the file is about (the wrong-file warning). */
    withKeywords: number;
    top: string[];
  } | null;
  /** Calls and tokens of the whole run (every MCAT, with and without context). Partial until `done`. */
  estimate: RunEstimate;
  done: boolean;
  /** MCATs worked through so far. */
  progress: number;
}

const EMPTY: McatPlanData = {
  keywords: null,
  estimate: { calls: 0, inputTokens: 0, outputTokens: 0 },
  done: true,
  progress: 0,
};

const idle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The keyword counts and the cost estimate for many MCATs. Doing all of them in one go froze the page for
 * seconds (each MCAT picks its keywords and builds its prompts), so they are worked through one MCAT at a
 * time with a pause in between for the page to paint and answer clicks, and a change of inputs drops the
 * work in flight. The numbers fill in as it goes.
 */
export function useMcatPlan(
  slices: McatSlice[],
  serpRows: Row[],
  internalRows: Row[],
  enabled: boolean,
): McatPlanData {
  const [data, setData] = useState<McatPlanData>(EMPTY);

  useEffect(() => {
    if (!enabled || slices.length < 2) {
      setData(EMPTY);
      return;
    }
    let cancelled = false;
    (async () => {
      const tables = [
        toKeywordTable(internalRows, "internal"),
        toKeywordTable(serpRows, "serp"),
      ].filter((t): t is KeywordTable => t !== null && t.rows.length > 0);
      const lines: Record<string, string> = {};
      let withKeywords = 0;
      const estimate: RunEstimate = { calls: 0, inputTokens: 0, outputTokens: 0 };
      const publish = (progress: number) =>
        setData({
          keywords: tables.length
            ? {
                lines: { ...lines },
                withKeywords,
                top: tables[0]!.rows.slice(0, 6).map((r) => r.query),
              }
            : null,
          estimate: { ...estimate },
          done: progress >= slices.length,
          progress,
        });
      publish(0);
      for (let i = 0; i < slices.length; i++) {
        await idle();
        if (cancelled) return;
        const s = slices[i]!;
        if (tables.length) {
          const picked = selectMcatKeywords(tables, s.inputs.mcat!);
          lines[s.name] = describeKeywordSelection(picked.selection);
          if (picked.tables.length > 0) withKeywords++;
        }
        // With a category context the run is repeated without it (labelling + design; the rest is cached).
        const records = previewPrompts(s.inputs);
        const without = s.inputs.context.trim()
          ? previewPrompts({ ...s.inputs, context: "" }).filter((r) => r.id !== "fields")
          : [];
        const one = estimateRun([...records, ...without]);
        estimate.calls += one.calls;
        estimate.inputTokens += one.inputTokens;
        estimate.outputTokens += one.outputTokens;
        if (i === slices.length - 1 || i % 8 === 7) publish(i + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slices, serpRows, internalRows, enabled]);

  return data;
}
