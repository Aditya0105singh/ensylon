import type { Alert, Cluster, PipelineState } from "../../model/types";

/** Minimal alert with sensible defaults; override what a test cares about. */
export const alert = (over: Partial<Alert> = {}): Alert => ({
  id: "a1",
  service: "api-gateway",
  alertname: "UpstreamTimeout",
  message: "Upstream timeout",
  severity: "critical",
  status: "firing",
  timestamp: "2026-07-16T10:00:00",
  source: "datadog",
  assignee: "n/a",
  dismissed: false,
  ...over,
});

export const cluster = (over: Partial<Cluster> = {}): Cluster => {
  const alerts = over.alerts ?? [alert()];
  return {
    cluster_id: 0,
    size: alerts.length,
    raw_alert_count: alerts.length,
    root_cause: alerts[0],
    risk: {
      score: 0.8,
      level: "high",
      factors: { growth_rate: 1, severity_trend: 0.8, service_spread: 0.4 },
      services_affected: 1,
    },
    dna_match: null,
    summary: "summary",
    est_triage_minutes_saved: 3,
    ...over,
    alerts,
  };
};

export const pipelineState = (
  over: Partial<PipelineState> = {}
): PipelineState => ({
  dedup_stats: {
    raw_count: 10,
    unique_count: 8,
    reduction_pct: 20,
    groups: {},
  },
  clusters: [],
  noise: [],
  raw_alerts: [],
  evaluation: null,
  ...over,
});
