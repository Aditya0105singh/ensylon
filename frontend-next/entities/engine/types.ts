/** Mirrors the shapes returned by backend/app/engine_api.py exactly - see
 * that file's _queue_summary / _draft_detail / _report_dict for the source
 * of truth. Kept as a separate entity from the original AlertLens pipeline
 * types since this is a distinct engine (app/engine/) with its own API
 * prefix, not a variant of the existing Cluster/Incident shapes. */

export type Priority = "P1" | "P2" | "P3" | "P4";

export type DraftStatus = "awaiting_review" | "published" | "rejected" | "merged";

export interface QueueSummary {
  draft_id: string;
  title: string;
  priority: Priority;
  severity_score: number;
  correlation_confidence: number;
  causal_confidence: number;
  root_cause_service: string | null;
  affected_services: string[];
  signal_count: number;
  started_at: string;
  status: DraftStatus;
  jira_key: string | null;
  merged_into: string | null;
  reviewer: string | null;
  suppressed: boolean;
  summary_source: "llm" | "template";
}

export interface TimelineEntry {
  at: string;
  source: string;
  service: string;
  detail: string;
  count: number;
}

export interface ExcludedSignal {
  service: string;
  at: string;
  detail: string;
  reason: string;
}

export interface DraftDetail extends QueueSummary {
  severity_line: string;
  root_cause_detail: string;
  summary: string;
  investigation_steps: string[];
  causal_reasoning: string[];
  severity_factors: Record<string, string>;
  redaction_kinds: string[];
  timeline: TimelineEntry[];
  considered_excluded: ExcludedSignal[];
  jira_fields: { summary: string; description: string; labels: string[] } | null;
  note: string;
  decided_at: string | null;
  lifecycle: "open" | "drafting" | "in_review" | "published" | "resolved";
  history: { state: string; at: string; note: string }[];
  jira_comments: { issue: string; body: string; at: string }[];
  updates: number;
  suppression_reason: string;
  /** Observed, computed facts - kept apart from the hypothesis below. */
  facts?: string[];
  /** The suspected root cause, worded as a hypothesis. */
  suspected_root_cause?: string;
  /** "template" or the Claude model that wrote the prose. */
  drafted_by?: string;
  historical_match: {
    incident_id: string;
    title: string;
    similarity_pct: number;
    resolution: string;
    resolution_minutes: number;
    shared_terms: string[];
    source: string;
  } | null;
}

export interface FeedbackState {
  decisions: {
    draft_id: string;
    action: string;
    services: string[];
    note: string;
    adjustment: {
      pattern: string[];
      action: string;
      before: Record<string, number>;
      after: Record<string, number>;
    } | null;
  }[];
  patterns: { pattern: string[]; weights: Record<string, number> }[];
}

export interface LateSignalResult {
  attached: boolean;
  gate?: string;
  reason?: string;
  draft_id: string | null;
  commented_on_jira?: string | null;
  incidents: number;
}

export interface Evaluation {
  // The pair counts behind the ratios below (absent on older backends).
  true_pairs?: number;
  predicted_pairs?: number;
  correct_pairs?: number;
  pair_precision: number;
  pair_recall: number;
  pair_f1: number;
  cluster_purity: number;
  incidents_expected: number;
  incidents_formed: number;
  root_cause_correct: number;
  root_cause_total: number;
  root_cause_accuracy: number;
  noise_precision: number;
}

export interface PipelineReport {
  scenario: string;
  signals_ingested: number;
  redaction_counts: Record<string, number>;
  redaction_backends: { regex: boolean; ner: boolean };
  unique_signals: number;
  dedup_collapsed: number;
  dedup_collapsed_pct: number;
  dedup_bucket_minutes: number;
  anomalies_detected: number;
  within_baseline: number;
  incidents_formed: number;
  noise_signals: number;
  root_causes_identified: number;
  drafts_created: number;
  auto_published: number;
  priorities: Record<string, number>;
  noise_reduction_pct: number;
  possible_pairs: number;
  candidate_pairs: number;
  blocking_saved_pct: number;
  calibration_warning: string | null;
  elapsed_ms: Record<string, number>;
  causal_splits: string[];
  evaluation?: Evaluation;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  draft_id: string;
  detail: string;
}

export interface Topology {
  name: string;
  services: string[];
  archetype_roles: string[];
}

export interface DemoRunRequest {
  n_incidents?: number;
  noise_signals?: number;
  seed?: number;
  stagger_minutes?: number;
  topology?: string | null;
  use_llm?: boolean;
}

/** GET /engine/queue/{id}/evidence — see backend/app/engine/evidence.py. */
export interface EvidenceSignal {
  id: string;
  at: string;
  source: string;
  service: string;
  message: string;
  severity: string;
  occurrences: number;
  trace_id: string | null;
  template_id: string | null;
  is_root_cause_signal: boolean;
  value: number | null;
  threshold: number | null;
  detection_reason: string;
  join: {
    joined: boolean;
    gate: string | null;
    linked_to: string | null;
    components: {
      time_proximity: number;
      service_affinity: number;
      dependency_closeness: number;
      template_similarity: number;
      component_match?: number;
      total: number;
    } | null;
  };
  badges: { label: string; ok: boolean }[];
}

export interface EvidenceExcluded {
  service: string;
  at: string;
  source: string;
  message: string;
  reason: string;
  checks: { label: string; ok: boolean }[];
}

export interface RootCauseCandidate {
  service: string;
  rank_score: number;
  temporal_precedence: number;
  dependency_reach: number;
  evidence_strength: number;
  is_symptom: boolean;
  symptom_of: string[];
  survived_counterfactual: boolean;
  uniquely_explains: string[];
  rejection_reason: string;
  first_seen: string | null;
  signal_count: number;
  source_kinds: string[];
}

export interface SeverityFactor {
  key: string;
  label: string;
  weight: number;
  value: number;
  contribution: number;
  note: string;
}

export interface Evidence {
  draft_id: string;
  raw_signals: number;
  unique_signals: number;
  signals: EvidenceSignal[];
  excluded: EvidenceExcluded[];
  correlation: {
    weights: Record<string, number>;
    confidence: {
      parts: { label: string; points: number }[];
      final: number;
      gate_reasons: Record<string, number>;
      validation?: { name: string; passed: boolean; detail: string }[];
    };
  };
  root_cause: {
    service: string | null;
    confidence: number;
    candidates: RootCauseCandidate[];
    rejected_by_counterfactual: string[];
    reasoning: string[];
  };
  severity: {
    score: number;
    priority: Priority;
    p1_threshold: number;
    p2_threshold: number;
    factors: SeverityFactor[];
    suppressed: boolean;
    suppression_reason: string;
    flap_count: number;
  };
}

/** GET /engine/health — the engine's own liveness: queue depth, integration
 * transports (live vs mock) and the last run's per-stage timings. */
export interface EngineHealth {
  status: string;
  uptime_seconds: number;
  started_at: string;
  persistence_enabled: boolean;
  run_loaded: boolean;
  scenario: string;
  queue: {
    awaiting_review: number;
    awaiting_review_p1: number;
    total_drafts: number;
    audit_entries: number;
  };
  notifications: {
    transport: string;
    live: boolean;
    sent: number;
    recent: { at: string; draft_id: string; reason: string; priority: string }[];
  };
  jira: { transport: string; live: boolean; published: number };
  llm: { configured_providers: string[]; live: boolean };
  last_pipeline_run: {
    signals_ingested: number;
    incidents_formed: number;
    elapsed_ms: Record<string, number>;
    calibration_warning: string | null;
  } | null;
}

/** GET /engine/benchmark — the engine scored on held-out generated estates. */
export interface BenchmarkRow {
  key: string;
  label: string;
  concurrent: boolean;
  runs: number;
  avg_signals: number;
  pair_precision: number;
  pair_recall: number;
  pair_f1: number;
  worst_pair_f1: number;
  cluster_purity: number;
  noise_precision: number;
  root_cause_correct: number;
  root_cause_total: number;
  root_cause_accuracy: number;
  exact_incident_count_runs: number;
  median_runtime_ms: number;
}

export interface EngineBenchmark {
  seeds: number[];
  held_out: boolean;
  configs: BenchmarkRow[];
  overall: {
    runs: number;
    pair_f1: number;
    pair_precision: number;
    pair_recall: number;
    root_cause_accuracy: number;
  };
}

/** GET /engine/benchmark/ablation — pair F1 with one dimension's weight
 * zeroed at a time, plus the gate-removed, time-only variant. */
export interface AblationRow {
  variant: string;
  pair_f1: number;
  delta: number | null;
  note?: string;
}

/** GET /engine/benchmark/reliability — predicted confidence vs. actual
 * cluster purity, bucketed in tenths. */
export interface ReliabilityBucket {
  bucket: string;
  predicted: number;
  actual: number;
  n: number;
}

/** GET /engine/stream/status - see backend/app/engine/live.py. */
export interface StreamReaderStatus {
  name: string;
  source: string;
  connected: boolean;
  last_event_id: string | null;
  events: number;
  signals: number;
  skipped: number;
  parse_errors: number;
  keepalives: number;
  reconnects: number;
  last_error: string | null;
  last_heard_seconds_ago: number | null;
}

/** A recording being played back instead of the live streams. */
export interface ReplayStatus {
  active: boolean;
  source?: string;
  recorded_at?: string | null;
  speed?: number;
  from?: string | null;
  played?: number;
  total?: number;
  finished?: boolean;
}

export interface StreamStatus {
  /** Present on backends with recording support. */
  replay?: ReplayStatus;
  /** Set when this run rebuilt its state from the session recording after a restart. */
  resumed?: { source: string; signals: number; events: number } | null;
  /** The recording this run is writing to, if any. */
  recording?: string | null;
  base_url: string;
  tickets_dir: string;
  graph_origin: string;
  uptime_seconds: number;
  tick_seconds: number;
  streams: StreamReaderStatus[];
  claude: { enabled: boolean; model: string; narrated?: number; fallback?: number };
  engine: {
    signals_received: number;
    by_source: Record<string, number>;
    anomalous: number;
    pending: number;
    incidents: number;
    noise: number;
    validation_rejections: number;
    /** PII tokens replaced, by kind. Absent on older backends. */
    redactions?: Record<string, number>;
    /** Repeated signals folded before correlation. Absent on older backends. */
    deduplicated?: number;
    ticks: number;
    stream_clock: string | null;
    last_signal_seconds_ago: number | null;
  };
}

/** One record in the challenge's canonical schema (already redacted). */
export interface CanonicalSignal {
  signal_id: string;
  timestamp: string;
  source: "cloudwatch_metrics" | "application_logs" | "grafana_alerts" | string;
  environment: string | null;
  region: string | null;
  service: string;
  component: string | null;
  signal_type: string;
  anomaly_score: number;
  evidence: string;
  metadata: Record<string, unknown>;
}

export interface ValidationRejection {
  at: string;
  services: string[];
  signals: number;
  failed: { name: string; passed: boolean; detail: string }[];
}

export interface ServiceGraph {
  origin: string;
  nodes: { id: string; criticality: number; incidents: string[]; root_cause_of: string[] }[];
  edges: { caller: string; callee: string }[];
}

/** GET /engine/stream/metrics - measured from the live streams. */
export interface StreamMetrics {
  timeline: ({ minute: string; anomalous?: number } & Record<string, number | string | undefined>)[];
  score_histogram: { lo: number; hi: number; count: number }[];
  dedup: { received: number; distinct: number; collapsed: number; collapsed_pct: number; bucket_minutes: number };
  top_repeats: { service: string; component: string | null; source: string; evidence: string; count: number; first: string; last: string }[];
  priorities: Record<string, number>;
}

/** Who took an action in the incident archive. "engine" for raised/updated. */
export interface ArchiveActor {
  name: string;
  email: string | null;
}

/** GET /engine/history/{id} - one row of the append-only sign-off trail. */
export interface ArchiveAuditEntry {
  seq: number;
  at: string;
  action: "raised" | "updated" | "approve" | "edit_and_approve" | "reject" | "resolve" | "merge" | string;
  actor: ArchiveActor;
  note: string;
  changes: Record<string, { before: unknown; after: unknown }> | null;
}

/** GET /engine/history - an incident as archived, across sessions and restarts. */
export interface ArchivedIncident {
  draft_id: string;
  title: string;
  priority: Priority;
  status: DraftStatus;
  severity_score: number;
  correlation_confidence: number;
  root_cause_service: string | null;
  affected_services: string[];
  signal_count: number;
  started_at: string;
  raised_at: string;
  updated_at: string;
  decided_at: string | null;
  decided_by: ArchiveActor | null;
  ticket_key: string | null;
  source: string | null;
}

export interface ArchivedIncidentDetail extends ArchivedIncident {
  detail: DraftDetail;
  evidence: Evidence | null;
  audit: ArchiveAuditEntry[];
}
