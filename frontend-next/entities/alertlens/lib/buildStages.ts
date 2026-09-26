import type { PipelineState } from "../model/types";

/**
 * Algorithm parameters mirrored from the backend source
 * (backend/app/dedup.py, clustering.py, risk_score.py, alert_dna.py).
 * Kept in sync by hand — the backend does not expose them over the API.
 */
export const DEDUP_WINDOW_SEC = 300;
export const EMBED_METHOD = "TF-IDF (1-2 word n-grams)";
export const DBSCAN_EPS = 1.0;
export const DBSCAN_MIN_SAMPLES = 3;
export const DNA_THRESHOLD = 25;

export interface StageDetail {
  purpose: string;
  algorithm: string;
  parameters?: string;
  inputs: string;
  outputs: string;
}

export interface Stage {
  id: string;
  label: string;
  metric: number;
  metricLabel: string;
  subMetric?: string;
  logLine: string;
  detail: StageDetail;
}

export function buildStages(state: PipelineState): Stage[] {
  const stats = state.dedup_stats;
  if (!stats) return [];

  const clusters = state.clusters ?? [];
  const noise = state.noise ?? [];
  const rawAlerts = state.raw_alerts ?? [];

  const sources = new Set(rawAlerts.map((a) => a.source)).size;
  const high = clusters.filter((c) => c.risk.level === "high").length;
  const medium = clusters.filter((c) => c.risk.level === "medium").length;
  const low = clusters.filter((c) => c.risk.level === "low").length;
  const matched = clusters.filter((c) => c.dna_match).length;
  const totalSaved = clusters.reduce(
    (s, c) => s + (c.est_triage_minutes_saved || 0),
    0
  );
  const dupCount = stats.raw_count - stats.unique_count;
  const plural = clusters.length === 1 ? "" : "s";

  return [
    {
      id: "ingest",
      label: "Ingest",
      metric: stats.raw_count,
      metricLabel: "alerts ingested",
      logLine: `Ingested ${stats.raw_count} alerts from ${sources} sources`,
      detail: {
        purpose:
          "Receive raw alerts from every monitoring source into one stream.",
        algorithm:
          "Webhook ingestion — a synthetic generator plays realistic incident cascades in this demo.",
        parameters: `${sources} active sources this window`,
        inputs: "Prometheus · Datadog · GCP Monitoring · Grafana · custom apps",
        outputs: `${stats.raw_count} raw alerts`,
      },
    },
    {
      id: "dedup",
      label: "Deduplication",
      metric: stats.unique_count,
      metricLabel: "unique alerts",
      subMetric: `−${dupCount} duplicates`,
      logLine: `Removed ${dupCount} duplicates (${stats.reduction_pct}%) → ${stats.unique_count} unique alerts`,
      detail: {
        purpose:
          "Collapse repeated firings of the same underlying condition — a stuck check re-fires every evaluation interval.",
        algorithm:
          "Fingerprint match: service + alert name + time bucket, keeping the earliest of each group.",
        parameters: `Window: ${DEDUP_WINDOW_SEC / 60} minutes`,
        inputs: `${stats.raw_count} raw alerts`,
        outputs: `${stats.unique_count} unique alerts (${stats.reduction_pct}% reduction)`,
      },
    },
    {
      id: "embed",
      label: "Embedding",
      metric: stats.unique_count,
      metricLabel: "vectors generated",
      logLine: `Vectorized ${stats.unique_count} alerts via ${EMBED_METHOD}`,
      detail: {
        purpose:
          "Convert each alert's text into a numeric vector so textual similarity can be measured.",
        algorithm: `scikit-learn TfidfVectorizer — ${EMBED_METHOD}`,
        parameters: "L2-normalized, vocabulary sized to this batch",
        inputs: `${stats.unique_count} unique alerts`,
        outputs: `${stats.unique_count} TF-IDF vectors`,
      },
    },
    {
      id: "cluster",
      label: "Correlation",
      metric: clusters.length,
      metricLabel: "incidents formed",
      subMetric: `${noise.length} kept as noise`,
      logLine: `DBSCAN formed ${clusters.length} incident${plural}, kept ${noise.length} alerts as background noise`,
      detail: {
        purpose:
          "Group alerts that are semantically related AND close in time into one incident — never force unrelated alerts together.",
        algorithm:
          "DBSCAN over a combined embedding-distance + time-proximity metric.",
        parameters: `eps = ${DBSCAN_EPS.toFixed(2)} · min_samples = ${DBSCAN_MIN_SAMPLES}`,
        inputs: `${stats.unique_count} embeddings`,
        outputs: `${clusters.length} incident clusters, ${noise.length} unclustered (background noise)`,
      },
    },
    {
      id: "risk",
      label: "Risk Scoring",
      metric: high,
      metricLabel: "high-risk incidents",
      subMetric: `${medium} med · ${low} low`,
      logLine: `Scored escalation risk — ${high} high, ${medium} medium, ${low} low`,
      detail: {
        purpose:
          "Rank which incidents are about to get worse, not just how big they already are.",
        algorithm: "Weighted, fully explainable score — no black box.",
        parameters:
          "0.40 × growth rate + 0.35 × severity trend + 0.25 × service spread",
        inputs: `${clusters.length} incidents`,
        outputs: `${high} high · ${medium} medium · ${low} low risk`,
      },
    },
    {
      id: "dna",
      label: "Alert DNA",
      metric: matched,
      metricLabel: `/ ${clusters.length} matched`,
      logLine: `Matched ${matched}/${clusters.length} incident${plural} to the Alert DNA library`,
      detail: {
        purpose:
          "Check whether this incident resembles one we've already resolved.",
        algorithm:
          "Cosine similarity between this incident's centroid and a library of past incidents.",
        parameters: `Match threshold: ${DNA_THRESHOLD}%`,
        inputs: `${clusters.length} incident centroids`,
        outputs: `${matched} matched to a known runbook, ${clusters.length - matched} novel pattern${clusters.length - matched === 1 ? "" : "s"}`,
      },
    },
    {
      id: "incident",
      label: "Incident Creation",
      metric: clusters.length,
      metricLabel: "actionable incidents",
      subMetric: `${totalSaved} min saved (est.)`,
      logLine: `Created ${clusters.length} incident${plural} — ~${totalSaved} min triage saved`,
      detail: {
        purpose:
          "Package each cluster into one incident an on-call engineer actually acts on.",
        algorithm: "Root cause = earliest / most severe alert in the cluster.",
        inputs: `${clusters.length} clusters`,
        outputs: `${clusters.length} incidents · ${
          stats.raw_count
            ? (100 * (1 - clusters.length / stats.raw_count)).toFixed(1)
            : 0
        }% noise reduction`,
      },
    },
  ];
}
