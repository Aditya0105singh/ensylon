import { useCallback } from "react";
import { useSWRConfig } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import { PIPELINE_KEY } from "./usePipeline";
import type { DemoLoadOptions, PipelineRunSummary } from "./types";

/**
 * Actions that replace the currently-loaded alert batch.
 *
 * Every one of these returns a PipelineRunSummary rather than the new state,
 * so each revalidates PIPELINE_KEY afterwards — that is what actually
 * refreshes the UI.
 */
export const usePipelineActions = () => {
  const api = useApi();
  const { mutate } = useSWRConfig();

  const refreshPipeline = useCallback(() => mutate(PIPELINE_KEY), [mutate]);

  /** POST /demo/load — synthetic batch, optionally seeded/scenario-forced. */
  const loadDemo = useCallback(
    async (opts: DemoLoadOptions = {}) => {
      const params = new URLSearchParams();
      if (opts.incidents != null) params.set("incidents", String(opts.incidents));
      if (opts.noise != null) params.set("noise", String(opts.noise));
      if (opts.seed != null) params.set("seed", String(opts.seed));
      if (opts.scenario) params.set("scenario", opts.scenario);
      const qs = params.toString() ? `?${params.toString()}` : "";

      const result = await api.post<PipelineRunSummary>(`/demo/load${qs}`);
      await refreshPipeline();
      return result;
    },
    [api, refreshPipeline]
  );

  /** POST /demo/load-bgl — Loghub BGL (BlueGene/L) 10k-alert sample. */
  const loadBgl = useCallback(async () => {
    const result = await api.post<PipelineRunSummary>("/demo/load-bgl");
    await refreshPipeline();
    return result;
  }, [api, refreshPipeline]);

  /** POST /ingest — run the pipeline over a caller-supplied alert batch. */
  const ingest = useCallback(
    async (alerts: Record<string, unknown>[]) => {
      const result = await api.post<PipelineRunSummary>("/ingest", alerts);
      await refreshPipeline();
      return result;
    },
    [api, refreshPipeline]
  );

  return { loadDemo, loadBgl, ingest, refreshPipeline };
};
