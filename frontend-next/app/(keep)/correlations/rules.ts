/**
 * The engine's rules as this page states them. Every value mirrors the backend
 * (checked against it, not the README):
 *   correlate.py  _gate_reason, time_proximity, service_affinity, _HOP_CLOSENESS,
 *                 WINDOW_MAX_MIN 15, TIME_SCALE_MIN 4, EPS 0.66, MIN_SAMPLES 2
 *   validate.py   MIN_DENSITY 0.25, WEAK_BRIDGE 0.50, MIN_ANOMALY 0.60, five checks
 *   lifecycle.py  late signals: gate + merge threshold, LATE_ATTACH_MAX_MIN 60
 *   stream.py     PENDING_WINDOW_MIN 15, SLICE_SECONDS 2
 *   severity.py   0.40 blast + 0.35 criticality + 0.25 magnitude; P1 .75 / P2 .50 / P3 .25
 * If a constant changes there, change it here.
 */

export const MERGE = 0.34;

export const DIMS = [
  { key: "time_proximity", code: "T", name: "Time proximity", weight: 0.25,
    how: "exp(−Δt / 4 min), and 0 beyond the 15-minute window" },
  { key: "service_affinity", code: "S", name: "Service affinity", weight: 0.2,
    how: "1.0 same service and component, 0.85 same service, else 0" },
  { key: "dependency_closeness", code: "D", name: "Dependency closeness", weight: 0.2,
    how: "hops on the reference graph: 0 → 1.0, 1 → 0.75, 2 → 0.45, 3 → 0.15" },
  { key: "template_similarity", code: "E", name: "Evidence similarity", weight: 0.2,
    how: "same Drain3 log template = 1.0, else token Jaccard on the redacted text" },
  { key: "component_match", code: "C", name: "Component match", weight: 0.15,
    how: "1.0 when both signals report the same component" },
] as const;

/** The gate strings the engine emits, in the order it tests them. */
export const GATES: { name: string; rule: string; color: string; fromStreams: boolean }[] = [
  { name: "shared trace_id", rule: "both signals carry the same trace id: literally the same request", color: "#2563eb", fromStreams: false },
  { name: "same service", rule: "both signals come from the same service", color: "#16a34a", fromStreams: true },
  { name: "direct dependency edge", rule: "one service calls the other on the reference graph (one hop, not two)", color: "#7c3aed", fromStreams: true },
  { name: "observed caller/callee in trace", rule: "a span shows one service calling the other", color: "#0891b2", fromStreams: false },
  { name: "service named in evidence", rule: "one signal names the other's service, e.g. “Circuit breaker OPEN for payments-service”", color: "#d97706", fromStreams: true },
  { name: "same component", rule: "same infrastructure component, at most 2 hops apart on the graph", color: "#db2777", fromStreams: true },
];

export const gateColor = (gate: string | null | undefined) =>
  GATES.find((g) => gate?.startsWith(g.name))?.color ?? "#9ca3af";

export const CHECKS = [
  { name: "Environment consistency", rule: "a candidate spanning prod and non-prod is split by environment" },
  { name: "Weak bridge", rule: "5+ signals held together by one signal whose best link scores below 0.50 are split at that signal" },
  { name: "Coherence", rule: "at least 25% of signal pairs directly linked (3 or fewer signals exempt)" },
  { name: "Anomaly support", rule: "the strongest signal must reach anomaly_score 0.60; a first-seen warning scores 0.55, so it can join but never anchor" },
  { name: "Independent evidence", rule: "at least two distinct conditions (service + source + template or metric); one condition repeated counts only at error or alarm severity" },
];

export const STREAMING = [
  { name: "Joining an open incident", rule: "a new signal joins an open incident only through the gate and with similarity ≥ 0.34 to a member, the same bar as forming one. The gate alone would let an incident grow one hop at a time and swallow unrelated failures nearby." },
  { name: "Waiting for a partner", rule: "an anomaly with no structural partner waits in a pending pool for 15 minutes of stream time, then expires as noise." },
  { name: "Backlog", rule: "a tick holding more than 2 s of event time (a stream's backlog on first connect, or a resume) is processed in 2 s slices, so it forms the same incidents as live arrival." },
  { name: "Late evidence", rule: "up to 60 minutes after an incident's last signal. Before approval it refreshes the draft; after, it is added to the written ticket, never a second ticket." },
];
