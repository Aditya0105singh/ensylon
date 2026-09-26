"""Predictive Blast Radius Forecast Engine — Differentiator Extension.

Produces an explainable, deterministic forecast using outputs from the existing pipeline
(risk score, growth rate, severity trend, service spread, root cause, alert DNA).

Calculates projected risk, alert growth acceleration, service blast radius expansion,
forecast confidence, recommended immediate actions, and observable evidence reasoning
over a 15-minute horizon (+5m, +10m, +15m).

This module is completely isolated and consumes existing cluster dictionaries without
rerunning or modifying clustering.
"""

from __future__ import annotations

import math
from typing import Any

# Known service dependency cascades mapped from root cause services
KNOWN_CASCADES: dict[str, list[list[str]]] = {
    "postgres-primary": [["order-api"], ["checkout-service", "billing-service"], ["notification-service"]],
    "redis-cache": [["session-service"], ["postgres-primary", "auth-service"], ["api-gateway"]],
    "worker-node-3": [["payment-worker"], ["kubelet-manager", "log-shipper"], ["metrics-collector"]],
    "auth-service": [["api-gateway"], ["mobile-bff", "checkout-service"], ["support-portal"]],
    "network-fabric": [["order-api"], ["inventory-service", "kafka-broker-2"], ["metrics-collector"]],
}

# Generic fallback cascade expansion candidates for unmapped root causes
GENERIC_EXPANSIONS: list[list[str]] = [
    ["api-gateway"],
    ["checkout-service", "billing-service"],
    ["notification-service", "analytics-pipeline"],
]


def _get_cascade_candidates(root_service: str) -> list[list[str]]:
    """Returns candidate new services that may be impacted at +5m, +10m, +15m steps."""
    for key, cascades in KNOWN_CASCADES.items():
        if key in root_service or root_service in key:
            return cascades
    return GENERIC_EXPANSIONS


def compute_forecast(cluster: dict[str, Any]) -> dict[str, Any]:
    """Computes an explainable predictive forecast for a single cluster.

    Args:
        cluster: Dictionary containing cluster details (risk, root_cause,
          dna_match, alerts, size, raw_alert_count, etc.)

    Returns:
        Structured forecast dictionary conforming to the required schema.
    """
    alerts = cluster.get("alerts", [])
    raw_alert_count = cluster.get("raw_alert_count", len(alerts))
    root_cause = cluster.get("root_cause", {})
    root_service = root_cause.get("service", "unknown-service")
    root_severity = root_cause.get("severity", "high")
    root_alertname = root_cause.get("alertname", "Incident")

    risk_info = cluster.get("risk", {})
    risk_score = risk_info.get("score", 0.5)  # float 0..1
    current_risk_pct = int(round(risk_score * 100))

    factors = risk_info.get("factors", {})
    growth_rate = factors.get("growth_rate", 0.4)
    severity_trend = factors.get("severity_trend", 0.4)
    service_spread = factors.get("service_spread", 0.4)

    dna_match = cluster.get("dna_match")
    dna_sim_pct = dna_match.get("similarity_pct", 0.0) if dna_match else 0.0
    dna_id = dna_match.get("incident_id") if dna_match else None

    existing_services = list({a.get("service") for a in alerts if a.get("service")})
    if not existing_services and root_service:
        existing_services = [root_service]

    cascade_tiers = _get_cascade_candidates(root_service)

    # Calculate growth acceleration factor based on risk score and severity
    severity_boost = 1.3 if root_severity == "critical" else (1.1 if root_severity == "high" else 1.0)
    growth_multiplier = max(1.0, (1.0 + growth_rate * 0.8) * severity_boost)

    # Base confidence score (starts high, adjusted by DNA match similarity and factors)
    base_confidence = 0.85
    if dna_match and dna_sim_pct > 0:
        base_confidence = min(0.96, base_confidence + (dna_sim_pct / 100.0) * 0.10)

    forecast_steps = []
    seen_services = set(existing_services)
    accumulated_alerts = raw_alert_count

    horizons = [(5, 0.40, cascade_tiers[0] if len(cascade_tiers) > 0 else []),
                (10, 0.70, cascade_tiers[1] if len(cascade_tiers) > 1 else []),
                (15, 0.95, cascade_tiers[2] if len(cascade_tiers) > 2 else [])]

    for mins, time_factor, candidate_services in horizons:
        # Projected risk delta increases with growth rate, severity trend, and cascade time
        risk_increment = (growth_rate * 12 + severity_trend * 10 + service_spread * 6) * (mins / 5.0) * severity_boost
        projected_risk = min(100, int(round(current_risk_pct + risk_increment)))

        # Projected alert count
        alert_increment = int(round((raw_alert_count * 0.25 + 6.0) * growth_multiplier * (mins / 5.0)))
        accumulated_alerts += alert_increment

        # New services affected in this time step
        new_svcs = []
        for svc in candidate_services:
            if svc not in seen_services:
                new_svcs.append(svc)
                seen_services.add(svc)

        # Step confidence decreases slightly further in time
        step_confidence = round(max(0.65, base_confidence - (mins - 5) * 0.015), 2)

        forecast_steps.append({
            "minutes": mins,
            "risk": projected_risk,
            "alerts": accumulated_alerts,
            "newServices": new_svcs,
            "confidence": step_confidence,
        })

    total_predicted_services = len(seen_services)
    overall_confidence = round(sum(s["confidence"] for s in forecast_steps) / len(forecast_steps), 2)

    # Recommended Immediate Action logic
    if dna_match and dna_match.get("resolution"):
        rec_action = f"Execute verified playbook from past incident {dna_id}: {dna_match['resolution']}"
    elif root_severity == "critical":
        rec_action = f"Isolate {root_service} immediately and trigger emergency failover to halt cascade expansion."
    elif "Connection" in root_alertname or "Pool" in root_alertname:
        rec_action = f"Expand connection pool on {root_service} and restart failing worker threads."
    elif "Memory" in root_alertname or "Cache" in root_alertname:
        rec_action = f"Flush non-essential key eviction policy on {root_service} and scale memory limits."
    elif "Disk" in root_alertname or "Space" in root_alertname:
        rec_action = f"Prune log archives on {root_service} and restart stalled pods."
    else:
        rec_action = f"Investigate root cause on {root_service} ({root_alertname}) and throttle downstream caller APIs."

    # Explainable Evidence Reasoning (NO AI jargon, purely observable evidence)
    reasoning = []
    if growth_rate > 0.5:
        reasoning.append(f"Alert velocity is escalating rapidly ({growth_rate * 100:.0f}% of max growth rate threshold)")
    elif growth_rate > 0.2:
        reasoning.append("Steady incoming alert volume observed across the past monitoring window")

    if severity_trend > 0.5:
        reasoning.append(f"Severity trend is elevated ({severity_trend * 100:.0f}%) with active critical/high symptoms")
    else:
        reasoning.append("Cluster severity is currently contained but trending upward")

    reasoning.append(f"{len(existing_services)} upstream/core service{'s' if len(existing_services) > 1 else ''} currently affected ({', '.join(existing_services[:3])})")

    if dna_match:
        reasoning.append(f"Historical Incident {dna_id} matched at {dna_sim_pct:.1f}% similarity with similar progression")
    else:
        reasoning.append("Novel incident signature detected; blast radius projected from topology dependency graph")

    if total_predicted_services > len(existing_services):
        new_total_svcs = [s for s in seen_services if s not in existing_services]
        reasoning.append(f"Downstream propagation risk to {len(new_total_svcs)} additional service{'s' if len(new_total_svcs) > 1 else ''}: {', '.join(new_total_svcs)}")

    return {
        "currentRisk": current_risk_pct,
        "confidence": overall_confidence,
        "recommendedImmediateAction": rec_action,
        "predictedBlastRadius": total_predicted_services,
        "forecast": forecast_steps,
        "reasoning": reasoning,
    }
