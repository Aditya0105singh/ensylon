import type { Alert, PipelineState } from "../model/types";

/**
 * Applies a field patch to one alert everywhere it appears in the pipeline
 * state — raw_alerts, every cluster's alerts, and noise. The same alert id is
 * present in more than one of those lists, so patching a single list would
 * leave the UI inconsistent between pages.
 *
 * Used for optimistic updates only. The server replays the whole batch after
 * an action (which can change cluster membership and risk), so the authoritative
 * result still arrives via revalidation — this just removes the visible lag.
 */
export function patchAlertInState(
  state: PipelineState | undefined,
  alertId: string,
  patch: Partial<Alert>
): PipelineState | undefined {
  if (!state) return state;

  const apply = (a: Alert): Alert =>
    a.id === alertId ? { ...a, ...patch } : a;

  return {
    ...state,
    raw_alerts: state.raw_alerts.map(apply),
    noise: state.noise.map(apply),
    clusters: state.clusters.map((c) => ({
      ...c,
      alerts: c.alerts.map(apply),
      root_cause: apply(c.root_cause),
    })),
  };
}
