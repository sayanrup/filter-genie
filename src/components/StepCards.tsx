import { useEffect, useState } from "react";
import { runCostInr, type ModelPreset, type Step, type StepId } from "@/lib/filter-gen";

/** A step as the page tracks it: the pipeline's report plus when it started (for the live timer). */
export type StepView = Step & { startedAt?: number };

const STATUS_PILL: Record<Step["status"], { text: string; cls: string }> = {
  pending: { text: "Waiting", cls: "bg-secondary text-muted-foreground" },
  running: { text: "Running", cls: "bg-primary-soft text-primary" },
  done: { text: "Finished", cls: "bg-success-soft text-success" },
  skipped: { text: "Skipped", cls: "bg-secondary text-muted-foreground" },
  error: { text: "Failed", cls: "bg-danger-soft text-destructive" },
};

const BORDER: Record<Step["status"], string> = {
  pending: "border-l-border",
  running: "border-l-primary",
  done: "border-l-success",
  skipped: "border-l-border",
  error: "border-l-destructive",
};

const fmtTokens = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${n}`;
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtInr = (n: number) => `₹${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

function costLine(s: StepView, preset: ModelPreset | undefined) {
  if (s.status === "pending" || s.status === "running") return null;
  if (s.cached) return "reused from this session · no cost";
  if (!s.calls) return "no model call";
  const inT = s.usage?.prompt_tokens ?? 0;
  const outT = s.usage?.completion_tokens ?? 0;
  const parts = [`${s.calls} call`, `${fmtTokens(inT)} in`, `${fmtTokens(outT)} out`];
  if (preset && (inT || outT)) parts.push(fmtInr(runCostInr(preset, inT, outT)));
  return parts.join(" · ");
}

function StatusIcon({ status }: { status: Step["status"] }) {
  const base = "flex size-9 shrink-0 items-center justify-center rounded-full text-base font-bold";
  if (status === "running")
    return <span className={`${base} animate-spin border-[3px] border-border border-t-primary`} />;
  if (status === "done")
    return <span className={`${base} bg-success text-success-foreground`}>✓</span>;
  if (status === "error")
    return <span className={`${base} bg-destructive text-destructive-foreground`}>!</span>;
  return (
    <span className={`${base} bg-secondary text-muted-foreground`}>
      {status === "skipped" ? "–" : ""}
    </span>
  );
}

function Working({ step }: { step: StepView }) {
  const box =
    "max-h-80 overflow-auto rounded-md border border-border bg-secondary/60 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap";
  return (
    <div className="mt-4 grid gap-3 lg:grid-cols-2">
      <div className="min-w-0">
        <div className="label-caps mb-1.5">Input</div>
        <pre className={box}>{step.input || "—"}</pre>
      </div>
      <div className="min-w-0">
        <div className="label-caps mb-1.5">Output</div>
        <pre className={box}>
          {step.output || (step.status === "running" ? "Waiting for the answer…" : "—")}
        </pre>
      </div>
    </div>
  );
}

export function StepCards({
  steps,
  preset,
  busy,
  onRerun,
}: {
  steps: StepView[];
  preset: ModelPreset | undefined;
  busy: boolean;
  onRerun: (from: StepId) => void;
}) {
  const [open, setOpen] = useState<Partial<Record<StepId, boolean>>>({});
  const [now, setNow] = useState(() => Date.now());
  const running = steps.some((s) => s.status === "running");

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [running]);

  const totals = steps.reduce(
    (acc, s) => ({
      ms: acc.ms + (s.ms ?? 0),
      calls: acc.calls + (s.cached ? 0 : (s.calls ?? 0)),
      inT: acc.inT + (s.cached ? 0 : (s.usage?.prompt_tokens ?? 0)),
      outT: acc.outT + (s.cached ? 0 : (s.usage?.completion_tokens ?? 0)),
    }),
    { ms: 0, calls: 0, inT: 0, outT: 0 },
  );
  const doneCount = steps.filter((s) => s.status === "done" || s.status === "skipped").length;

  return (
    <section className="mt-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-base font-semibold">Watch it work</h2>
        <div className="font-mono text-[11px] text-muted-foreground">
          {doneCount}/{steps.length} steps · {totals.calls} model call
          {totals.calls === 1 ? "" : "s"} · {fmtTokens(totals.inT)} in · {fmtTokens(totals.outT)}{" "}
          out
          {preset && (totals.inT || totals.outT)
            ? ` · ${fmtInr(runCostInr(preset, totals.inT, totals.outT))}`
            : ""}
        </div>
      </div>

      <ol className="grid gap-3">
        {steps.map((s, i) => {
          const pill = STATUS_PILL[s.status];
          const elapsed = s.status === "running" && s.startedAt ? now - s.startedAt : s.ms;
          const cost = costLine(s, preset);
          const hasWorking = Boolean(s.input || s.output);
          return (
            <li key={s.id} className={`panel border-l-4 ${BORDER[s.status]} px-4 py-4 sm:px-5`}>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                <div className="flex min-w-0 flex-1 gap-3">
                  <StatusIcon status={s.status} />
                  <div className="min-w-0">
                    <h3 className="font-display text-[15px] font-semibold">
                      <span className="mr-1.5 text-muted-foreground">{i + 1}.</span>
                      {s.label}
                    </h3>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{s.description}</p>
                    {s.detail ? (
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">{s.detail}</p>
                    ) : null}
                    {s.stats?.length ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {s.stats.map((st) => (
                          <span
                            key={st.label}
                            className="rounded-md bg-secondary px-2 py-1 text-xs text-muted-foreground"
                          >
                            <strong className="font-mono text-foreground">
                              {typeof st.value === "number" ? st.value.toLocaleString() : st.value}
                            </strong>{" "}
                            {st.label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="flex shrink-0 flex-row flex-wrap items-center gap-2 sm:w-52 sm:flex-col sm:items-end">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${pill.cls}`}>
                    ● {pill.text}
                  </span>
                  {elapsed !== undefined ? (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {fmtMs(elapsed)}
                    </span>
                  ) : null}
                  {cost ? (
                    <span
                      className={`font-mono text-[11px] text-muted-foreground ${s.calls ? "" : "italic"}`}
                    >
                      {cost}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRerun(s.id)}
                    title={
                      s.id === "prepare"
                        ? "Run everything again, asking the model afresh at every step"
                        : "Keep the steps above as they are and ask the model afresh from this step"
                    }
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Re-run from here
                  </button>
                  <button
                    type="button"
                    disabled={!hasWorking}
                    onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {open[s.id] ? "Hide the working" : "See the working"}
                  </button>
                </div>
              </div>
              {open[s.id] && hasWorking ? <Working step={s} /> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
