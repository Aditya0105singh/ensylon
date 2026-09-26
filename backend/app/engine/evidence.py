"""Evidence bundle: everything a reviewer needs to challenge one incident.

The pipeline already computes the reasons; this module only re-derives the
per-signal join evidence from the same functions the correlator used
(`similarity`, `_gate_reason`), so the numbers shown are the ones the engine
acted on, not a parallel implementation that could drift.

Nothing here decides anything. It answers, for one incident:
  * why each signal joined (gate reason + similarity components),
  * what was considered and rejected, and which gate condition it failed,
  * why this root cause and not another (ranked candidates, counterfactual),
  * how the severity score adds up, and how correlation confidence was built.
"""

from __future__ import annotations

from typing import Any

from .correlate import (
    W_COMPONENT,
    W_DEPENDENCY,
    W_SERVICE,
    W_TEMPLATE,
    W_TIME,
    DependencyGraph,
    _gate_reason,
    near_misses,
    similarity,
)
from .severity import (
    P1_THRESHOLD,
    P2_THRESHOLD,
    P3_THRESHOLD,
    W_BLAST,
    W_CRITICALITY,
    W_DIVERSITY,
    W_MAGNITUDE,
    W_TREND,
)

_GATE_RANK = {
    "shared trace_id": 0,
    "same service": 1,
    "direct dependency edge": 2,
    "observed caller/callee in trace": 3,
}


def _signal_join(sig, others, graph: DependencyGraph) -> dict[str, Any]:
    """How does this signal attach to the rest of the cluster?

    Picks the strongest admissible link (shared trace beats same service beats
    a dependency edge) and reports the similarity components for it.
    """
    best = None
    for other in others:
        if other is sig:
            continue
        gate = _gate_reason(sig, other, graph)
        if gate is None:
            continue
        sim = similarity(sig, other, graph)
        key = (_GATE_RANK.get(gate, 9), -(sim.total if sim else 0.0))
        if best is None or key < best[0]:
            best = (key, other, gate, sim)

    if best is None:
        return {"joined": False, "gate": None, "linked_to": None, "components": None}

    _, other, gate, sim = best
    return {
        "joined": True,
        "gate": gate,
        "linked_to": other.service,
        "components": None if sim is None else {
            "time_proximity": round(sim.time, 2),
            "service_affinity": round(sim.service, 2),
            "dependency_closeness": round(sim.dependency, 2),
            "template_similarity": round(sim.template, 2),
            "component_match": round(sim.component, 2),
            "total": round(sim.total, 2),
        },
    }


def _badges(join: dict[str, Any], sig, cluster) -> list[dict[str, Any]]:
    c = join["components"] or {}
    gate = join["gate"]
    traces = {s.trace_id for s in cluster.signals if s.trace_id}
    return [
        {"label": "Same service", "ok": gate == "same service" or bool(c and c["service_affinity"] >= 1.0)},
        {"label": "Dependency link", "ok": bool(c and c["dependency_closeness"] > 0)},
        {"label": "Shared trace ID", "ok": bool(sig.trace_id and sig.trace_id in traces and gate == "shared trace_id")},
        {"label": "Template match", "ok": bool(c and c["template_similarity"] >= 0.3)},
        {"label": "Inside window", "ok": bool(c and c["time_proximity"] > 0)},
    ]


def _confidence_parts(cluster) -> dict[str, Any]:
    """Break the correlation confidence into its terms.

    Validated clusters carry the brief's formula (density, topology support,
    evidence agreement; see validate.correlation_confidence). Anything that
    skipped validation falls back to the correlator's own estimate.
    """
    reasons = cluster.gate_reasons or {}
    if getattr(cluster, "confidence_parts", None):
        return {"parts": cluster.confidence_parts, "final": cluster.confidence, "gate_reasons": reasons,
                "validation": getattr(cluster, "validation", [])}
    total = sum(reasons.values()) or 1
    strong = reasons.get("shared trace_id", 0) + reasons.get("same service", 0)
    share = strong / total
    parts = [
        {"label": "Baseline", "points": 0.35},
        {"label": f"Strong evidence ({strong}/{total} links via trace or same service)", "points": round(0.45 * share, 2)},
        {"label": f"Mean pair similarity ({cluster.mean_similarity:.2f})", "points": round(0.30 * cluster.mean_similarity, 2)},
    ]
    return {"parts": parts, "final": cluster.confidence, "gate_reasons": reasons}


def build_evidence(incident, graph: DependencyGraph, noise: list) -> dict[str, Any]:
    cluster, causal, severity, draft = incident.cluster, incident.causal, incident.severity, incident.draft

    signals = []
    root_sig = causal.root_cause_signal
    for sig in sorted(cluster.signals, key=lambda s: s.timestamp):
        join = _signal_join(sig, cluster.signals, graph)
        signals.append({
            "id": sig.id,
            "at": sig.timestamp.isoformat(),
            "source": str(getattr(sig.source, "value", sig.source)),
            "service": sig.service,
            "message": sig.message,
            "severity": str(getattr(sig.severity, "value", sig.severity)),
            "occurrences": sig.occurrence_count,
            "trace_id": sig.trace_id,
            "template_id": sig.template_id,
            "is_root_cause_signal": bool(root_sig and sig.id == root_sig.id),
            "value": sig.value,
            "threshold": sig.threshold,
            "detection_reason": sig.detection_reason,
            "join": join,
            "badges": _badges(join, sig, cluster),
        })

    excluded = [
        {
            "service": s.service,
            "at": s.timestamp.isoformat(),
            "source": str(getattr(s.source, "value", s.source)),
            "message": s.message,
            "reason": reason,
            "checks": [
                {"label": "Shared service", "ok": s.service in set(cluster.services)},
                {"label": "Dependency edge", "ok": any(graph.has_direct_edge(s.service, svc) for svc in cluster.services)},
                {"label": "Shared trace ID", "ok": bool(s.trace_id and s.trace_id in {x.trace_id for x in cluster.signals})},
            ],
        }
        for s, reason in near_misses(cluster, noise, graph)
    ]

    candidates = [
        {
            "service": c.service,
            "rank_score": c.rank_score,
            "temporal_precedence": round(c.temporal_precedence, 2),
            "dependency_reach": round(c.dependency_reach, 2),
            "evidence_strength": round(c.evidence_strength, 2),
            "is_symptom": c.is_symptom,
            "symptom_of": c.symptom_of,
            "survived_counterfactual": c.ablation_survived,
            "uniquely_explains": c.uniquely_explains,
            "rejection_reason": c.rejection_reason,
            "first_seen": c.first_seen.isoformat() if c.first_seen else None,
            "signal_count": c.signal_count,
            "source_kinds": c.source_kinds,
        }
        for c in causal.candidates
    ]

    factors = [
        {"key": "blast_radius", "label": "Blast radius", "weight": W_BLAST, "value": severity.blast_radius,
         "note": severity.factors.get("blast radius", "")},
        {"key": "business_criticality", "label": "Business criticality", "weight": W_CRITICALITY,
         "value": severity.business_criticality, "note": severity.factors.get("business criticality", "")},
        {"key": "anomaly_magnitude", "label": "Anomaly magnitude", "weight": W_MAGNITUDE,
         "value": severity.anomaly_magnitude, "note": severity.factors.get("anomaly magnitude", "")},
        # Context only (weight 0): shown so the reviewer sees them, not scored.
        {"key": "trend", "label": "Trend direction (context)", "weight": W_TREND, "value": severity.trend_direction,
         "note": severity.factors.get("trend", "")},
        {"key": "signal_diversity", "label": "Signal diversity (context)", "weight": W_DIVERSITY,
         "value": severity.signal_diversity, "note": severity.factors.get("signal diversity", "")},
    ]
    for f in factors:
        f["contribution"] = round(f["weight"] * f["value"], 3)

    return {
        "draft_id": draft.draft_id,
        "raw_signals": sum(s.occurrence_count for s in cluster.signals),
        "unique_signals": len(cluster.signals),
        "signals": signals,
        "excluded": excluded,
        "correlation": {
            "weights": {
                "time_proximity": W_TIME, "service_affinity": W_SERVICE,
                "dependency_closeness": W_DEPENDENCY, "template_similarity": W_TEMPLATE,
                "component_match": W_COMPONENT,
            },
            "confidence": _confidence_parts(cluster),
        },
        "root_cause": {
            "service": causal.root_cause_service,
            "confidence": causal.confidence,
            "candidates": candidates,
            "rejected_by_counterfactual": causal.rejected_by_ablation,
            "reasoning": causal.reasoning,
        },
        "severity": {
            "score": severity.score,
            "impact": severity.impact,
            "priority": severity.priority,
            "p1_threshold": P1_THRESHOLD,
            "p2_threshold": P2_THRESHOLD,
            "p3_threshold": P3_THRESHOLD,
            "factors": factors,
            "suppressed": severity.suppressed,
            "suppression_reason": severity.suppression_reason,
            "flap_count": severity.flap_count,
        },
    }
