import type {
  CanonicalSignal,
  Evidence,
  EvidenceSignal,
  QueueSummary,
  RootCauseCandidate,
} from "@/entities/engine/types";

/** Must match EPS in backend/app/engine/correlate.py (similarity >= 1 - EPS). */
export const MERGE_THRESHOLD = 0.45;
/** Must match the anomaly-support validation minimum in validate.py. */
export const ANOMALY_THRESHOLD = 0.6;

export type CanonicalSource = "application_logs" | "cloudwatch_metrics" | "grafana_alerts";

/** Evidence uses the engine's internal source enum (app_log, cloudwatch_metric,
 * grafana_alert, cloudwatch_log); the canonical schema uses the brief's names. */
export function canonicalSource(source: string): CanonicalSource {
  const s = source.toLowerCase();
  if (s.includes("grafana")) return "grafana_alerts";
  if (s.includes("metric")) return "cloudwatch_metrics";
  return "application_logs";
}

export const cleanTitle = (title: string) => title.replace(/^\[DRAFT\]\s*/i, "");

export const impact = (q: Pick<QueueSummary, "severity_score">) => Math.round(q.severity_score * 100);

const PRIORITY_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };

/** Awaiting review first, then by priority, then by impact. */
export function rankIncidents(queue: QueueSummary[]): QueueSummary[] {
  const live = queue.filter((q) => q.status !== "merged");
  return [...live].sort((a, b) => {
    const ra = a.status === "awaiting_review" ? 0 : 1;
    const rb = b.status === "awaiting_review" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    const pa = PRIORITY_RANK[a.priority] ?? 9;
    const pb = PRIORITY_RANK[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return b.severity_score - a.severity_score;
  });
}

export const DIMENSIONS = [
  { key: "time_proximity", code: "T", label: "Temporal proximity" },
  { key: "service_affinity", code: "S", label: "Shared service" },
  { key: "dependency_closeness", code: "D", label: "Topology distance" },
  { key: "template_similarity", code: "E", label: "Evidence similarity" },
  { key: "component_match", code: "C", label: "Same component" },
] as const;

/** One color per similarity dimension, shared by every page that draws them. */
export const DIM_COLOR: Record<string, string> = {
  time_proximity: "#0ea5e9",
  service_affinity: "#16a34a",
  dependency_closeness: "#7c3aed",
  template_similarity: "#f59e0b",
  component_match: "#ec4899",
};

export type DimensionContribution = {
  key: string;
  code: string;
  label: string;
  weight: number;
  mean: number;
  contribution: number;
};

/** Mean of each similarity dimension over the signals that joined, times its
 * weight. The contributions add up to the mean similarity of the joins. */
export function correlationBreakdown(ev: Evidence): { dims: DimensionContribution[]; total: number; joins: number } {
  const joined = ev.signals.filter((s) => s.join.joined && s.join.components);
  const weights = ev.correlation.weights ?? {};
  const dims = DIMENSIONS.map((d) => {
    const values = joined.map((s) => Number((s.join.components as Record<string, number>)[d.key] ?? 0));
    const mean = values.length ? values.reduce((a, v) => a + v, 0) / values.length : 0;
    const weight = Number(weights[d.key] ?? 0);
    return { ...d, weight, mean, contribution: weight * mean };
  });
  const total = dims.reduce((a, d) => a + d.contribution, 0);
  return { dims, total, joins: joined.length };
}

export type SourceMix = Record<CanonicalSource, number>;

/** Raw (pre-dedup) signal count per stream for one incident. */
export function sourceMix(signals: EvidenceSignal[]): SourceMix {
  const mix: SourceMix = { application_logs: 0, cloudwatch_metrics: 0, grafana_alerts: 0 };
  signals.forEach((s) => {
    mix[canonicalSource(s.source)] += Math.max(1, s.occurrences || 1);
  });
  return mix;
}

export type PropagationStep = {
  service: string;
  firstSeen: string | null;
  signals: number;
  isRoot: boolean;
  from: string | null;
};

/** Order the incident's services from the probable origin outwards, following
 * the symptom_of links the causal stage produced. Services with no link are
 * appended by first-seen time so nothing is hidden. */
export function propagationPath(ev: Evidence): PropagationStep[] {
  const candidates = ev.root_cause.candidates ?? [];
  const root = ev.root_cause.service;
  const byService = new Map<string, RootCauseCandidate>(candidates.map((c) => [c.service, c]));
  const out: PropagationStep[] = [];
  const seen = new Set<string>();
  const push = (service: string, from: string | null) => {
    if (seen.has(service)) return;
    seen.add(service);
    const c = byService.get(service);
    out.push({
      service,
      firstSeen: c?.first_seen ?? null,
      signals: c?.signal_count ?? 0,
      isRoot: service === root,
      from,
    });
  };
  const byTime = (a: RootCauseCandidate, b: RootCauseCandidate) =>
    (a.first_seen ?? "").localeCompare(b.first_seen ?? "");

  if (root) push(root, null);
  for (let i = 0; i < out.length; i++) {
    const parent = out[i].service;
    candidates
      .filter((c) => c.symptom_of.includes(parent))
      .sort(byTime)
      .forEach((c) => push(c.service, parent));
  }
  [...candidates].sort(byTime).forEach((c) => push(c.service, null));
  return out;
}

export type SignalClass = "correlated" | "anomaly" | "normal";

/** A signal is "correlated" when an open or reviewed incident covers its
 * service and it was anomalous at or after that incident began. */
export function classifySignal(s: CanonicalSignal, incidents: QueueSummary[]): { kind: SignalClass; incident?: QueueSummary } {
  if (s.anomaly_score < ANOMALY_THRESHOLD) return { kind: "normal" };
  const t = Date.parse(s.timestamp);
  const incident = incidents.find(
    (q) => q.status !== "rejected" && q.affected_services.includes(s.service) && t >= Date.parse(q.started_at) - 1000
  );
  return incident ? { kind: "correlated", incident } : { kind: "anomaly" };
}

/** Seconds between two ISO timestamps, rendered as +Ns / +Nm Ns. */
export function offset(fromIso: string, toIso: string): string {
  const s = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (s < 60) return `+${s}s`;
  return `+${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export const clockUTC = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

/** Must match PENDING_WINDOW_MIN in backend/app/engine/stream.py. */
export const PENDING_WINDOW_MIN = 15;

export type AnomalyFate =
  | { kind: "incident"; incident: QueueSummary }
  | { kind: "waiting"; minutesLeft: number }
  | { kind: "expired" };

/** What became of one anomalous signal: it joined an incident, it is still
 * waiting (up to the pending window) for a structural partner, or it expired
 * as noise. Measured against stream time, not wall time. */
export function anomalyFate(s: CanonicalSignal, incidents: QueueSummary[], streamClock: string | null): AnomalyFate {
  const c = classifySignal(s, incidents);
  if (c.kind === "correlated" && c.incident) return { kind: "incident", incident: c.incident };
  const now = streamClock ? Date.parse(streamClock) : Date.now();
  const ageMin = (now - Date.parse(s.timestamp)) / 60000;
  if (ageMin >= PENDING_WINDOW_MIN) return { kind: "expired" };
  return { kind: "waiting", minutesLeft: Math.max(1, Math.ceil(PENDING_WINDOW_MIN - ageMin)) };
}

/** 3240 -> "54 min", 7500 -> "2 h 05 min". */
export function formatDuration(seconds: number): string {
  const m = Math.max(0, Math.floor(seconds / 60));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** One sentence on why the engine raised nothing, from its own counters. */
export function quietReason(engine: { signals_received: number; anomalous: number; pending: number }): string {
  if (engine.signals_received === 0) return "No signals yet, only keepalives. Silence raises nothing.";
  if (engine.anomalous === 0) return "Every signal is within its baseline, so there is nothing to correlate.";
  const waiting = engine.pending > 0 ? ` ${engine.pending} ${engine.pending === 1 ? "is" : "are"} still waiting for a partner.` : "";
  return (
    `${plural(engine.anomalous, "anomaly", "anomalies")} found, but none shared a service path, a dependency edge, ` +
    `a component or a log template with another. Time alone never links two signals.${waiting}`
  );
}
