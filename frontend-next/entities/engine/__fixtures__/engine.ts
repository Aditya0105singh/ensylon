import type { DraftDetail, EngineHealth, Evaluation, Evidence, PipelineReport, QueueSummary } from "../types";

/** Shared canned data for engine-entity tests, shaped exactly like the real
 * /engine/* responses (see backend/app/engine_api.py's _queue_summary /
 * _draft_detail / _report_dict) but with round, easy-to-assert-on numbers
 * rather than a real scenario's exact values. */

export const queueSummary = (overrides: Partial<QueueSummary> = {}): QueueSummary => ({
  draft_id: "draft-0-123",
  title: "[DRAFT] postgres-primary: DatabaseConnections cascading to 3 service(s)",
  priority: "P1",
  severity_score: 0.85,
  correlation_confidence: 0.78,
  causal_confidence: 93,
  root_cause_service: "postgres-primary",
  affected_services: ["postgres-primary", "order-api", "checkout-bff"],
  signal_count: 6,
  started_at: "2026-08-26T14:02:03Z",
  status: "awaiting_review",
  jira_key: null,
  merged_into: null,
  reviewer: null,
  suppressed: false,
  summary_source: "template",
  ...overrides,
});

export const draftDetail = (overrides: Partial<DraftDetail> = {}): DraftDetail => ({
  ...queueSummary(),
  severity_line: "P1 — 0.85 (blast 0.56 · criticality 1.00 · trend 1.00 · diversity 1.00)",
  root_cause_detail: "postgres-primary — DatabaseConnections = 200 (threshold 180)",
  summary: "postgres-primary's connection pool saturated, cascading through order-api.",
  investigation_steps: ["Inspect postgres-primary first", "Check DatabaseConnections against its threshold"],
  causal_reasoning: ["postgres-primary ranked highest on temporal precedence and dependency reach"],
  severity_factors: { "blast radius": "3 service(s) affected", "business criticality": "postgres-primary (criticality 0.95)" },
  redaction_kinds: [],
  timeline: [{ at: "2026-08-26T14:02:03Z", source: "cloudwatch_metric", service: "postgres-primary", detail: "DatabaseConnections = 200", count: 1 }],
  considered_excluded: [{ service: "log-archive", at: "2026-08-26T14:03:22Z", detail: "DiskUsage", reason: "no shared service, dependency edge, or trace id" }],
  jira_fields: null,
  note: "",
  decided_at: null,
  lifecycle: "in_review",
  history: [
    { state: "open", at: "2026-08-26T14:02:03Z", note: "correlated into an incident" },
    { state: "drafting", at: "2026-08-26T14:02:03Z", note: "ticket assembled" },
    { state: "in_review", at: "2026-08-26T14:02:03Z", note: "waiting for a human decision" },
  ],
  jira_comments: [],
  updates: 0,
  suppression_reason: "",
  historical_match: null,
  ...overrides,
});

export const pipelineReport = (overrides: Partial<PipelineReport> = {}): PipelineReport => ({
  scenario: "golden incident: connection-pool exhaustion on postgres-primary",
  signals_ingested: 18,
  redaction_counts: {},
  redaction_backends: { regex: true, ner: false },
  unique_signals: 7,
  dedup_collapsed: 11,
  dedup_collapsed_pct: 61.1,
  dedup_bucket_minutes: 5,
  anomalies_detected: 7,
  within_baseline: 0,
  incidents_formed: 1,
  noise_signals: 1,
  root_causes_identified: 1,
  drafts_created: 1,
  auto_published: 0,
  priorities: { P1: 1 },
  noise_reduction_pct: 94.4,
  possible_pairs: 21,
  candidate_pairs: 12,
  blocking_saved_pct: 42.9,
  calibration_warning: null,
  elapsed_ms: { redact: 0.5, deduplicate: 0.3, detect: 0.4, correlate: 1.2, causal_score_draft: 0.8 },
  causal_splits: [],
  ...overrides,
});

export const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  draft_id: "draft-0-123",
  raw_signals: 17,
  unique_signals: 6,
  signals: [
    {
      id: "sig-root", at: "2026-08-26T14:02:03Z", source: "cloudwatch_metric", service: "postgres-primary",
      message: "Threshold Crossed: DatabaseConnections = 200", severity: "critical", occurrences: 1,
      trace_id: null, template_id: null, is_root_cause_signal: true, value: 200, threshold: 180,
      detection_reason: "CloudWatch alarm in ALARM state",
      join: { joined: true, gate: "direct dependency edge", linked_to: "order-api", components: { time_proximity: 0.9, service_affinity: 0, dependency_closeness: 0.6, template_similarity: 0, total: 0.51 } },
      badges: [{ label: "Dependency link", ok: true }, { label: "Inside window", ok: true }, { label: "Same service", ok: false }],
    },
    {
      id: "sig-log", at: "2026-08-26T14:02:11Z", source: "cloudwatch_log", service: "order-api",
      message: "ERROR connection pool exhausted: 196/200 in use, waiters=14", severity: "high", occurrences: 12,
      trace_id: null, template_id: "T1", is_root_cause_signal: false, value: null, threshold: null,
      detection_reason: "novel error template T1 not seen in baseline",
      join: { joined: true, gate: "same service", linked_to: "order-api", components: { time_proximity: 0.95, service_affinity: 1, dependency_closeness: 0, template_similarity: 0.3, total: 0.75 } },
      badges: [{ label: "Same service", ok: true }, { label: "Inside window", ok: true }, { label: "Shared trace ID", ok: false }],
    },
  ],
  excluded: [
    {
      service: "log-archive", at: "2026-08-26T14:03:22Z", source: "cloudwatch_metric",
      message: "Threshold Crossed: DiskUsage = 86.0", reason: "no shared service, dependency edge, or trace id",
      checks: [{ label: "Shared service", ok: false }, { label: "Dependency edge", ok: false }, { label: "Shared trace ID", ok: false }],
    },
  ],
  correlation: {
    weights: { time_proximity: 0.3, service_affinity: 0.25, dependency_closeness: 0.25, template_similarity: 0.2 },
    confidence: {
      parts: [{ label: "Baseline", points: 0.35 }, { label: "Strong evidence (2/2 links)", points: 0.26 }, { label: "Mean pair similarity (0.63)", points: 0.19 }],
      final: 0.78,
      gate_reasons: { "direct dependency edge": 1, "same service": 1 },
    },
  },
  root_cause: {
    service: "postgres-primary",
    confidence: 0.93,
    candidates: [
      { service: "postgres-primary", rank_score: 0.89, temporal_precedence: 1, dependency_reach: 1, evidence_strength: 0.65, is_symptom: false, symptom_of: [], survived_counterfactual: true, uniquely_explains: ["order-api"], rejection_reason: "", first_seen: "2026-08-26T14:02:03Z", signal_count: 1, source_kinds: ["metric"] },
      { service: "order-api", rank_score: 0.61, temporal_precedence: 0.67, dependency_reach: 0.33, evidence_strength: 0.92, is_symptom: true, symptom_of: ["postgres-primary"], survived_counterfactual: false, uniquely_explains: [], rejection_reason: "rejected by counterfactual: removing it leaves every affected service still explained by another failing dependency", first_seen: "2026-08-26T14:02:11Z", signal_count: 12, source_kinds: ["log"] },
    ],
    rejected_by_counterfactual: ["order-api"],
    reasoning: ["postgres-primary ranked highest (0.89) on temporal precedence 100%, dependency reach 100%, evidence 0.65."],
  },
  severity: {
    score: 0.846,
    priority: "P1",
    p1_threshold: 0.75,
    p2_threshold: 0.45,
    factors: [
      { key: "blast_radius", label: "Blast radius", weight: 0.35, value: 0.56, contribution: 0.196, note: "4 service(s) affected" },
      { key: "business_criticality", label: "Business criticality", weight: 0.3, value: 1.0, contribution: 0.3, note: "payment-svc (criticality 1.00)" },
      { key: "trend", label: "Trend direction", weight: 0.2, value: 1.0, contribution: 0.2, note: "rising (4 signals in 2nd half vs 2 in 1st)" },
      { key: "signal_diversity", label: "Signal diversity", weight: 0.15, value: 1.0, contribution: 0.15, note: "3 source families: log, metric, trace" },
    ],
    suppressed: false,
    suppression_reason: "",
    flap_count: 1,
  },
  ...overrides,
});

export const evaluation = (overrides: Partial<Evaluation> = {}): Evaluation => ({
  pair_precision: 1.0,
  pair_recall: 1.0,
  pair_f1: 1.0,
  cluster_purity: 1.0,
  incidents_expected: 1,
  incidents_formed: 1,
  root_cause_correct: 1,
  root_cause_total: 1,
  root_cause_accuracy: 1.0,
  noise_precision: 1.0,
  ...overrides,
});

export const engineHealth = (overrides: Partial<EngineHealth> = {}): EngineHealth => ({
  status: "ok",
  uptime_seconds: 3600,
  started_at: "2026-09-24T16:00:00Z",
  persistence_enabled: true,
  run_loaded: true,
  scenario: "golden incident",
  queue: { awaiting_review: 1, awaiting_review_p1: 1, total_drafts: 1, audit_entries: 2 },
  notifications: { transport: "MockNotificationTransport", live: false, sent: 1, recent: [] },
  jira: { transport: "MockJiraTransport", live: false, published: 0 },
  llm: { configured_providers: [], live: false },
  last_pipeline_run: {
    signals_ingested: 18,
    incidents_formed: 1,
    elapsed_ms: { redact: 1.2, deduplicate: 0.4, correlate: 4.6 },
    calibration_warning: null,
  },
  ...overrides,
});
