import {
  runPipeline,
  type LlmSettings,
  type PipelineRun,
  type Step,
  type StepId,
} from "./filter-gen";
import type { McatSlice } from "./mcats";

export interface McatHooks {
  signal?: AbortSignal;
  /** Re-run each MCAT from this step (earlier steps reuse this session's cached answers). */
  from?: StepId;
  /** MCATs running at once. One (the default) is gentlest on a provider's rate limit; more is faster. */
  concurrency?: number;
  onStart: (index: number) => void;
  onStep: (index: number, id: StepId, patch: Partial<Step>) => void;
  onDone: (index: number, run: PipelineRun) => void;
  onError: (index: number, error: Error) => void;
}

const idle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Runs the pipeline once per MCAT, `concurrency` at a time. One MCAT failing is reported and the rest carry on; Stop (abort)
 * ends every MCAT that is running and leaves the ones not yet started untouched. Resolves when all
 * workers have finished, so the caller can mark whatever never started.
 */
export async function runMcats(
  settings: LlmSettings,
  slices: McatSlice[],
  hooks: McatHooks,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < slices.length && !hooks.signal?.aborted) {
      const i = next++;
      // Let the page paint and answer clicks before this MCAT's (synchronous) preparation starts.
      await idle();
      if (hooks.signal?.aborted) break;
      hooks.onStart(i);
      try {
        const run = await runPipeline(settings, slices[i]!.inputs, {
          onStep: (id, patch) => hooks.onStep(i, id, patch),
          ...(hooks.signal ? { signal: hooks.signal } : {}),
          ...(hooks.from ? { from: hooks.from } : {}),
        });
        hooks.onDone(i, run);
      } catch (err) {
        hooks.onError(i, err as Error);
      }
    }
  };
  const workers = Math.max(1, Math.min(hooks.concurrency ?? 1, slices.length));
  await Promise.all(Array.from({ length: workers }, worker));
}
