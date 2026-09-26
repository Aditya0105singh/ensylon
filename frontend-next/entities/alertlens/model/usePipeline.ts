import useSWR, { SWRConfiguration } from "swr";
import { useMemo } from "react";
import { useApi } from "@/shared/lib/hooks/useApi";
import type { Alert, Cluster, DedupStats, PipelineState } from "./types";
import { projectStorm, useStormStore } from "./useStormStore";

/**
 * SWR key for the whole pipeline state. Every AlertLens page reads from this
 * one key, so a single fetch feeds all of them and any mutation only has to
 * revalidate this to refresh the entire app.
 */
export const PIPELINE_KEY = "/pipeline";

const EMPTY_STATE: PipelineState = {
  dedup_stats: null,
  clusters: [],
  noise: [],
  raw_alerts: [],
  evaluation: null,
};

/** How often to re-poll the pipeline, matching the original AlertLens UI. */
export const PIPELINE_REFRESH_MS = 30_000;

/** GET /pipeline — current dedup stats, clusters, noise and raw alerts. */
export const usePipeline = (options: SWRConfiguration = {}) => {
  const api = useApi();
  const isStorming = useStormStore((s) => s.full !== null);

  return useSWR<PipelineState>(
    api.isReady() ? PIPELINE_KEY : null,
    (url: string) => api.get(url),
    {
      // Keep a long-lived dashboard current, but hold off during a storm
      // replay so a refetch can't disturb the batch being replayed.
      refreshInterval: isStorming ? 0 : PIPELINE_REFRESH_MS,
      // Default (false) already skips polling while the tab is hidden; pair
      // that with a refetch on return so coming back shows current data
      // instead of waiting out the rest of the interval.
      revalidateOnFocus: !isStorming,
      ...options,
    }
  );
};

/**
 * Pipeline state with the null-ish cases already collapsed, so pages can
 * render without guarding every field.
 *
 * While a storm replay is running this returns the *projected* state — the
 * same engine output with alerts that haven't been "received" yet held back —
 * so every page animates from chaos to order without any page-level changes.
 */
export const usePipelineState = (options?: SWRConfiguration) => {
  const { data, error, isLoading, mutate } = usePipeline(options);
  const stormFull = useStormStore((s) => s.full);
  const schedule = useStormStore((s) => s.schedule);
  const elapsed = useStormStore((s) => s.elapsed);

  const state = useMemo(() => {
    if (!stormFull || !schedule) return data ?? EMPTY_STATE;
    const revealed = new Set<string>();
    schedule.forEach((at, id) => {
      if (at <= elapsed) revealed.add(id);
    });
    return projectStorm(stormFull, revealed);
  }, [data, stormFull, schedule, elapsed]);

  return {
    state,
    isLoading: stormFull ? false : isLoading,
    error,
    mutate,
  };
};

export const useClusters = (options?: SWRConfiguration) => {
  const { state, isLoading, error } = usePipelineState(options);
  return { clusters: state.clusters, isLoading, error };
};

/** A single incident (cluster) by its cluster_id. */
export const useIncident = (
  incidentId: string | number | null | undefined,
  options?: SWRConfiguration
) => {
  const { state, isLoading, error } = usePipelineState(options);

  const incident = useMemo<Cluster | null>(() => {
    if (incidentId === null || incidentId === undefined) return null;
    return (
      state.clusters.find(
        (c) => String(c.cluster_id) === String(incidentId)
      ) ?? null
    );
  }, [state.clusters, incidentId]);

  return {
    incident,
    isLoading,
    error,
    // Distinguishes "still loading" from "loaded, and this id isn't there".
    notFound: !isLoading && !error && incidentId != null && incident === null,
  };
};

export const useRawAlerts = (options?: SWRConfiguration) => {
  const { state, isLoading, error } = usePipelineState(options);
  return { alerts: state.raw_alerts, isLoading, error };
};

export const useNoiseAlerts = (options?: SWRConfiguration) => {
  const { state, isLoading, error } = usePipelineState(options);
  return { noise: state.noise, isLoading, error };
};

export const useDedupStats = (options?: SWRConfiguration) => {
  const { state, isLoading, error } = usePipelineState(options);
  return {
    dedupStats: state.dedup_stats as DedupStats | null,
    isLoading,
    error,
  };
};

/**
 * Raw alerts filtered the way the AlertLens feed variants do:
 * firingOnly -> /firing, criticalOnly -> /5xx.
 */
export const useFilteredAlerts = (
  { firingOnly = false, criticalOnly = false } = {},
  options?: SWRConfiguration
) => {
  const { state, isLoading, error } = usePipelineState(options);

  const alerts = useMemo<Alert[]>(() => {
    let result = state.raw_alerts;
    if (firingOnly) result = result.filter((a) => a.status === "firing");
    if (criticalOnly) result = result.filter((a) => a.severity === "critical");
    return result;
  }, [state.raw_alerts, firingOnly, criticalOnly]);

  return { alerts, isLoading, error };
};
