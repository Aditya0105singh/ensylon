/**
 * Types for the AlertLens FastAPI backend (backend/app/main.py).
 *
 * These mirror the shapes the backend actually returns at runtime, captured
 * from a live /pipeline response — not an OpenAPI generation. The backend is
 * the source of truth; nothing here should drive a backend change.
 */

/** Values the backend actually emits: "critical" | "high" | "info". */
export type Severity = "critical" | "high" | "info" | string;
/** Values the backend actually emits: "firing" | "resolved" | "suppressed". */
export type AlertStatus = "firing" | "resolved" | "suppressed" | string;

export interface Alert {
  id: string;
  service: string;
  alertname: string;
  message: string;
  severity: Severity;
  status: AlertStatus;
  /** ISO-8601, no timezone suffix (e.g. "2026-07-16T10:35:32"). */
  timestamp: string;
  source: string;
  /** "n/a" when unassigned. */
  assignee: string;
  dismissed: boolean;
  /** Generator's hidden label. The pipeline never reads this; evaluation does. */
  ground_truth?: string;
  /**
   * Added by the dedup step, so present on `clusters[].alerts` and `noise`
   * but NOT on `raw_alerts` (which is the pre-dedup list).
   */
  fingerprint?: string;
  /** How many raw alerts collapsed into this one. Same caveat as fingerprint. */
  duplicate_count?: number;
  // Merged from the actions table by _apply_actions(), so only present
  // once a user has acted on the alert.
  acked?: boolean;
  escalated?: boolean;
}

export interface DedupStats {
  raw_count: number;
  unique_count: number;
  reduction_pct: number;
  /** fingerprint -> number of raw alerts sharing it. */
  groups: Record<string, number>;
}

export interface RiskFactors {
  growth_rate: number;
  severity_trend: number;
  service_spread: number;
}

export interface Risk {
  score: number;
  level: "high" | "medium" | "low" | string;
  factors: RiskFactors;
  services_affected: number;
}

export interface DnaMatch {
  similarity_pct: number;
  incident_id: string;
  title: string;
  date: string;
  symptom_pattern: string;
  root_cause: string;
  resolution?: string;
  resolution_minutes?: number;
}

/** The alert the engine picked as the cluster's likely origin. */
export type RootCause = Alert;

export interface Cluster {
  /** Numeric label from the clustering step, used as the incident id in URLs. */
  cluster_id: number;
  size: number;
  raw_alert_count: number;
  root_cause: RootCause;
  risk: Risk;
  dna_match: DnaMatch | null;
  summary: string;
  est_triage_minutes_saved: number;
  alerts: Alert[];
}

/** GET /pipeline */
export interface PipelineState {
  dedup_stats: DedupStats | null;
  clusters: Cluster[];
  /** Alerts the clusterer labelled -1 (uncorrelated). */
  noise: Alert[];
  raw_alerts: Alert[];
  evaluation: Evaluation | null;
}

/**
 * What the mutating endpoints return — a summary, NOT the full state.
 * Callers must revalidate /pipeline to pick up the new state.
 */
export interface PipelineRunSummary {
  raw_alerts: number;
  after_dedup: number;
  clusters_formed: number;
  uncorrelated: number;
}

/** GET /forecast/{incident_id} */
export interface ForecastPoint {
  minutes: number;
  risk: number;
  alerts: number;
  newServices: string[];
  confidence: number;
}

export interface Forecast {
  currentRisk: number;
  confidence: number;
  recommendedImmediateAction: string;
  predictedBlastRadius: number;
  forecast: ForecastPoint[];
  reasoning: string[] | string;
}

/** GET /incidents/{incident_id}/comparison */
export interface ComparisonIncidentSummary {
  service: string;
  alertname: string;
  severity: Severity;
  risk_score: number;
  risk_level: string;
  alert_count: number;
  services: string[];
  [key: string]: unknown;
}

/** GET /incidents/{id}/comparison — a row is "info" when the two sides are
 * genuinely different quantities (e.g. a current estimate vs a past outcome)
 * and there is no honest match/partial/different verdict to render. */
export interface ComparisonMetric {
  field: string;
  current: string;
  historical: string;
  status: "match" | "partial" | "different" | "info";
}

export interface ComparisonTimelinePoint {
  time: string;
  text: string;
}

export interface HistoricalIncident {
  incident_id: string;
  title: string;
  date: string;
  symptom_pattern: string;
  root_cause: string;
  resolution: string;
  resolution_minutes: number;
  services_affected: string[];
  similarity_pct: number;
}

export interface IncidentComparison {
  incident_id: string;
  has_match: boolean;
  similarity: number;
  confidence: number;
  /** Two honestly-measured numbers: the TF-IDF cosine similarity AlertDNA
   * computed, and the current incident's real service overlap with the
   * matched one. Never a five-way breakdown implying more was measured. */
  similarity_breakdown: { symptom_similarity: number; service_overlap: number };
  current_incident: ComparisonIncidentSummary;
  historical_incident: HistoricalIncident | null;
  comparison_metrics: ComparisonMetric[];
  timeline_comparison: {
    current: ComparisonTimelinePoint[];
    historical: ComparisonTimelinePoint[];
  };
  historical_resolution: string | null;
  resolution_minutes: number | null;
  suggested_actions: string[];
}

/** GET /incidents/{incident_id}/root_cause_confidence */
export interface RootCauseCandidate {
  service: string;
  confidence: number;
  score: number;
  alertname: string;
  severity: Severity;
  is_selected: boolean;
  explanation: string[];
}

export interface RootCauseConfidence {
  selected_root_cause: {
    service: string;
    alertname: string;
    severity: Severity;
    confidence: number;
  };
  candidates: RootCauseCandidate[];
  evidence: unknown;
  decision_tree: unknown;
  reasoning: string[] | string;
}

/** GET /incidents/{incident_id}/playbook */
/** GET /incidents/{id}/correlation — why the clusterer grouped these alerts,
 * recomputed with the same distance the run used. */
export interface CorrelationFactor {
  key: string;
  label: string;
  score: number;
  detail: string;
}

export interface CorrelationReason {
  ok: boolean;
  text: string;
}

export interface ExcludedAlert {
  id: string;
  alertname: string;
  service: string;
  severity: string;
  timestamp: string;
  distance: number;
  reasons: string[];
}

export interface CorrelationExplanation {
  confidence_pct: number;
  factors: CorrelationFactor[];
  reasons: CorrelationReason[];
  excluded: ExcludedAlert[];
  params: {
    eps: number;
    min_samples: number;
    time_scale_min: number;
    time_penalty?: number;
  };
}

/** GET /incidents/{id}/ticket — the reviewable ticket draft and its state. */
export interface IncidentTicket {
  draft_id: string;
  title: string;
  priority: string;
  labels: string[];
  description: string;
  summary: string;
  summary_source: string;
  investigation_steps: string[];
  affected_services: string[];
  signal_count: number;
  correlation_confidence: number;
  status: string;
  published: boolean;
  jira: {
    mode: string;
    configured: boolean;
    key: string | null;
    approved_by: string | null;
  };
  audit?: string[];
}

export interface PlaybookStep {
  step_number: number;
  title: string;
  description: string;
  [key: string]: unknown;
}

export interface Playbook {
  title: string;
  priority: string;
  /** Which failure family the incident's own alert text matched, or null. */
  failure_family: string | null;
  /** Only set when a similar past incident gives a real baseline. */
  estimated_resolution: string | null;
  resolution_basis: string;
  confidence: number | null;
  steps: PlaybookStep[];
  validation: string[];
  rollback: string[];
  impact: unknown;
}

/** GET /evaluation */
export interface EvaluationSeedResult {
  seed: number;
  incident_detection_pct: number;
  cluster_purity_pct: number;
  noise_excluded_pct: number;
}

export interface Evaluation {
  seeds_tested: number;
  per_seed: EvaluationSeedResult[];
  incidents_total: number;
  incidents_detected: number;
  incident_detection_pct: number;
  cluster_purity_pct: number;
  fragmentation_events: number;
  noise_excluded_pct: number;
  dna_correct: number;
  dna_total: number;
  dna_accuracy_pct: number;
}

/** GET /debug/summarizer-check */
export interface SummarizerCheck {
  [key: string]: unknown;
}

/** POST /assistant and /assistant/workspace */
export interface AssistantMessage {
  role: "user" | "assistant" | string;
  content: string;
}

export interface AssistantRequest {
  question: string;
  conversation?: AssistantMessage[];
  incident_id?: string | number;
  workspace_context?: Record<string, unknown>;
}

export interface AssistantResponse {
  answer?: string;
  error?: string;
  [key: string]: unknown;
}

/** Options accepted by POST /demo/load. */
export interface DemoLoadOptions {
  incidents?: number;
  noise?: number;
  seed?: number | null;
  scenario?: string | null;
}

/** GET /settings/status — real system facts, not a settings form. */
export interface SettingsStatus {
  dataset: string;
  persisted_alert_count: number;
  active_incident_count: number;
  llm_configured: boolean;
  llm_provider: string | null;
  db_path: string;
}

/** GET /rules/config — the real, already-tuned correlation engine
 * parameters, read-only (not an editable rules CRUD). */
export interface RulesConfig {
  dedup: {
    window_seconds: number;
    description: string;
  };
  clustering: {
    eps: number;
    min_samples: number;
    time_scale_minutes: number;
    time_penalty: number;
    description: string;
  };
  root_cause: {
    description: string;
  };
}

/** A real time window that suppresses alerts from a service (or every
 * service, if unset) — evaluated against wall-clock time on every pipeline
 * run, not a persisted per-alert action. GET/POST/PUT/DELETE /maintenance. */
export interface MaintenanceWindow {
  id: string;
  name: string;
  service: string | null;
  start_time: string;
  end_time: string;
  enabled: boolean;
  created_at: string;
  /** Computed server-side right now: enabled AND start_time <= now <= end_time. */
  active: boolean;
}
