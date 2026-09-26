"""End-to-end orchestration: raw telemetry in, reviewed tickets out.

Runs the six capabilities in order — ingest, detect, correlate, score, draft,
review — with the causal engine between correlation and scoring. Nothing here
writes to a customer environment; the only write in the system happens when a
human approves a draft in the review queue.

`evaluate()` measures the run against injected ground truth. Correlation
quality is not something to assert, and "the clusters look right" is not a
number — precision and recall are.
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from itertools import combinations
from typing import Any

from . import adapters, causal as causal_mod
from . import validate as validate_mod
from .correlate import Cluster, DependencyGraph, correlate, near_misses
from .dedup import deduplicate
from .detect import DetectorState, detect
from .drafting import ExcludedSignal, IncidentDraft, build_draft
from .redaction import redact_all, redaction_backends
from .review import ReviewQueue
from .severity import MaintenanceWindow, SeverityBreakdown, p1_rate_warning, score_incident
from .signal import Signal


@dataclass
class IncidentResult:
    """One incident, fully analysed, with its draft awaiting review."""

    cluster: Cluster
    causal: causal_mod.CausalResult
    severity: SeverityBreakdown
    draft: IncidentDraft


@dataclass
class PipelineReport:
    signals_ingested: int = 0
    redaction_counts: dict[str, int] = field(default_factory=dict)
    redaction_backends: dict[str, bool] = field(default_factory=dict)
    unique_signals: int = 0
    dedup_collapsed: int = 0
    dedup_collapsed_pct: float = 0.0
    dedup_bucket_minutes: float = 0.0
    anomalies_detected: int = 0
    within_baseline: int = 0
    incidents_formed: int = 0
    noise_signals: int = 0
    possible_pairs: int = 0
    candidate_pairs: int = 0
    root_causes_identified: int = 0
    drafts_created: int = 0
    auto_published: int = 0
    priorities: dict[str, int] = field(default_factory=dict)
    calibration_warning: str | None = None
    elapsed_ms: dict[str, float] = field(default_factory=dict)
    detection_reasons: dict[str, int] = field(default_factory=dict)
    causal_splits: list[str] = field(default_factory=list)
    validation_rejections: list[dict] = field(default_factory=list)

    @property
    def noise_reduction_pct(self) -> float:
        if not self.signals_ingested:
            return 0.0
        return round(100.0 * (1 - self.incidents_formed / self.signals_ingested), 1)

    @property
    def blocking_saved_pct(self) -> float:
        if not self.possible_pairs:
            return 0.0
        return round(100.0 * (1 - self.candidate_pairs / self.possible_pairs), 1)


@dataclass
class PipelineResult:
    incidents: list[IncidentResult]
    noise: list[Signal]
    signals: list[Signal]
    report: PipelineReport
    queue: ReviewQueue
    detector_state: DetectorState


class _Timer:
    def __init__(self, report: PipelineReport, name: str):
        self.report, self.name = report, name

    def __enter__(self):
        self.start = time.perf_counter()
        return self

    def __exit__(self, *exc):
        self.report.elapsed_ms[self.name] = round(
            (time.perf_counter() - self.start) * 1000, 1
        )
        return False


def ingest_raw(payloads: dict[str, list[dict]]) -> tuple[list[Signal], set[tuple[str, str]]]:
    """Normalize every source payload into Signals, and harvest topology.

    Dependency edges come from *all* spans including healthy ones — topology
    learned only from failing traffic is exactly the topology you cannot trust
    during an incident.
    """
    signals: list[Signal] = []
    edges: set[tuple[str, str]] = set()

    for alarm in payloads.get("cloudwatch_alarms", []):
        signal = adapters.from_cloudwatch_alarm(alarm)
        if signal:
            signals.append(signal)
    for response in payloads.get("cloudwatch_logs", []):
        signals.extend(adapters.from_cloudwatch_logs(response))
    for batch in payloads.get("grafana", []):
        signals.extend(adapters.from_grafana_webhook(batch))
    for payload in payloads.get("otlp_logs", []):
        signals.extend(adapters.from_otlp_logs(payload))
    for payload in payloads.get("otlp_traces", []):
        signals.extend(adapters.from_otlp_traces(payload))
        edges |= adapters.service_dependency_edges(payload)

    signals.sort(key=lambda s: s.timestamp)
    return signals, edges


def run(
    signals: list[Signal],
    graph: DependencyGraph,
    detector_state: DetectorState | None = None,
    maintenance: list[MaintenanceWindow] | None = None,
    queue: ReviewQueue | None = None,
    use_llm: bool = True,
    criticality: dict[str, float] | None = None,
    weights: dict[str, float] | None = None,
) -> PipelineResult:
    """Run redact → deduplicate → detect → correlate → causal → score → draft → queue.

    `weights` overrides the correlation dimension weights for this run only
    (see correlate.similarity); used by the ablation benchmark."""
    report = PipelineReport(signals_ingested=len(signals))
    queue = queue or ReviewQueue()

    # --- redaction, before anything is stored or sent anywhere ---
    with _Timer(report, "redact"):
        signals, counts = redact_all(signals)
    report.redaction_counts = counts
    report.redaction_backends = redaction_backends()

    # --- deduplicate: collapse repeated firings of the same condition ---
    with _Timer(report, "deduplicate"):
        signals, dedup_report = deduplicate(signals)
    report.unique_signals = dedup_report.unique_signals
    report.dedup_collapsed = dedup_report.collapsed
    report.dedup_collapsed_pct = dedup_report.collapsed_pct
    report.dedup_bucket_minutes = dedup_report.bucket_minutes

    # --- detect ---
    with _Timer(report, "detect"):
        signals, detection, detector_state = detect(signals, detector_state)
    report.anomalies_detected = detection.anomalous
    report.within_baseline = detection.within_baseline
    report.detection_reasons = detection.by_reason

    # --- correlate ---
    with _Timer(report, "correlate"):
        clusters, noise, correlation = correlate(signals, graph, weights)
        # Similarity cannot separate two incidents that hit the same service
        # at the same moment; causality can. See causal.refine_clusters.
        clusters, split_notes = causal_mod.refine_clusters(clusters, graph)
        # C4: candidates must pass validation before becoming incidents.
        verdict = validate_mod.validate(clusters, graph)
        clusters = verdict.accepted
        for rejected, checks in verdict.rejected:
            noise.extend(rejected.signals)
            report.validation_rejections.append({
                "services": rejected.services,
                "signals": len(rejected.signals),
                "failed": [c.as_dict() for c in checks if not c.passed],
            })
        correlation.clusters_formed = len(clusters)
    report.causal_splits = split_notes
    report.incidents_formed = correlation.clusters_formed
    report.noise_signals = correlation.noise
    report.possible_pairs = correlation.possible_pairs
    report.candidate_pairs = correlation.candidate_pairs

    # --- causal, score, draft ---
    incidents: list[IncidentResult] = []
    breakdowns: list[SeverityBreakdown] = []

    with _Timer(report, "causal_score_draft"):
        for cluster in clusters:
            result = causal_mod.analyse(cluster, graph)
            severity = score_incident(cluster, result, graph, maintenance, criticality)
            excluded = [
                ExcludedSignal(
                    service=signal.service,
                    at=signal.timestamp,
                    detail=(signal.metric or signal.message or "")[:70],
                    reason=reason,
                )
                for signal, reason in near_misses(cluster, noise, graph)
            ]
            draft = build_draft(cluster, result, severity, excluded, use_llm=use_llm)

            incidents.append(IncidentResult(cluster, result, severity, draft))
            breakdowns.append(severity)
            if result.root_cause_service:
                report.root_causes_identified += 1

    # --- review queue: every draft stops here ---
    for incident in incidents:
        queue.submit(incident.draft)

    report.drafts_created = len(incidents)
    report.auto_published = 0  # structurally impossible — reported to prove it
    priorities: dict[str, int] = defaultdict(int)
    for breakdown in breakdowns:
        priorities[breakdown.priority] += 1
    report.priorities = dict(priorities)
    report.calibration_warning = p1_rate_warning(breakdowns)

    return PipelineResult(
        incidents=incidents,
        noise=noise,
        signals=signals,
        report=report,
        queue=queue,
        detector_state=detector_state,
    )


# --------------------------------------------------------------------------
# evaluation
# --------------------------------------------------------------------------


@dataclass
class Evaluation:
    """Pairwise correlation quality plus root-cause accuracy.

    Measured pairwise rather than per-cluster because that is the question
    that actually matters operationally: for any two signals, did the system
    correctly decide whether they belong to the same incident? Cluster-count
    accuracy can look perfect while the contents are scrambled.
    """

    pair_precision: float = 0.0
    pair_recall: float = 0.0
    pair_f1: float = 0.0
    true_pairs: int = 0
    predicted_pairs: int = 0
    correct_pairs: int = 0
    cluster_purity: float = 0.0
    incidents_expected: int = 0
    incidents_formed: int = 0
    root_cause_correct: int = 0
    root_cause_total: int = 0
    noise_precision: float = 0.0

    @property
    def root_cause_accuracy(self) -> float:
        if not self.root_cause_total:
            return 0.0
        return round(self.root_cause_correct / self.root_cause_total, 3)

    def render(self) -> str:
        return (
            f"pair precision {self.pair_precision:.3f} · recall {self.pair_recall:.3f} "
            f"· F1 {self.pair_f1:.3f} | purity {self.cluster_purity:.3f} | "
            f"root cause {self.root_cause_correct}/{self.root_cause_total} "
            f"({self.root_cause_accuracy:.0%}) | incidents {self.incidents_formed}"
            f"/{self.incidents_expected}"
        )


def evaluate(result: PipelineResult, expected_incidents: int) -> Evaluation:
    """Score a run against the ground truth carried on the signals."""
    ev = Evaluation(
        incidents_expected=expected_incidents,
        incidents_formed=len(result.incidents),
    )

    # --- pairwise correlation quality ---
    truth_groups: dict[str, list[str]] = defaultdict(list)
    for signal in result.signals:
        if signal.truth_incident:
            truth_groups[signal.truth_incident].append(signal.id)

    true_pairs: set[tuple[str, str]] = set()
    for members in truth_groups.values():
        true_pairs.update(
            (a, b) if a < b else (b, a) for a, b in combinations(sorted(members), 2)
        )

    predicted_pairs: set[tuple[str, str]] = set()
    for incident in result.incidents:
        ids = sorted(s.id for s in incident.cluster.signals)
        predicted_pairs.update(
            (a, b) if a < b else (b, a) for a, b in combinations(ids, 2)
        )

    correct = true_pairs & predicted_pairs
    ev.true_pairs = len(true_pairs)
    ev.predicted_pairs = len(predicted_pairs)
    ev.correct_pairs = len(correct)
    ev.pair_precision = round(len(correct) / len(predicted_pairs), 3) if predicted_pairs else 0.0
    ev.pair_recall = round(len(correct) / len(true_pairs), 3) if true_pairs else 0.0
    if ev.pair_precision + ev.pair_recall:
        ev.pair_f1 = round(
            2 * ev.pair_precision * ev.pair_recall / (ev.pair_precision + ev.pair_recall), 3
        )

    # --- purity: share of clustered signals sitting with their own majority ---
    total, matched = 0, 0
    for incident in result.incidents:
        labels = [s.truth_incident or "NOISE" for s in incident.cluster.signals]
        if not labels:
            continue
        dominant = max(set(labels), key=labels.count)
        matched += labels.count(dominant)
        total += len(labels)
    ev.cluster_purity = round(matched / total, 3) if total else 0.0

    # --- root cause accuracy ---
    for incident in result.incidents:
        truth_roots = {s.service for s in incident.cluster.signals if s.truth_is_root_cause}
        if not truth_roots:
            continue
        ev.root_cause_total += 1
        if incident.causal.root_cause_service in truth_roots:
            ev.root_cause_correct += 1

    # --- noise precision: of what we called noise, how much really was ---
    if result.noise:
        genuine = sum(1 for s in result.noise if not s.truth_incident)
        ev.noise_precision = round(genuine / len(result.noise), 3)

    return ev
